import { UploadError } from '../../../types/error'
import { LogLevel, Logger } from '../../../helper/logger'
import { generateRandomString } from '../../../helper/string'
import { Result, isCanceledResult, isErrorResult, isSuccessResult } from '../../../types/types'

const delay = (ms = 1000) => new Promise(resolve => setTimeout(resolve, ms))

export interface TaskState {
  retryCount: number
  status: TaskStatus
}

type ProgressNotice = () => void
export type OnError = () => void
export type OnCancel = () => void
export type OnProgress = () => void
export type OnComplete = () => void
export type TaskStatus = 'waiting' | 'processing' | 'canceled' | 'error' | 'success'

export interface Task {
  cancel(): Promise<Result>
  process(notice: ProgressNotice): Promise<Result>
}

type TaskCreator = () => Promise<Result<Task[]>>

interface LoggerOptions {
  level: LogLevel
  prefix: string
}

interface TaskQueueOptions {
  logger?: LoggerOptions
  concurrentLimit?: number
  tasksCreator?: TaskCreator
}

export class TaskQueue implements Task {
  private logger: Logger
  /** 取消标记 */
  private canceled = false
  /** 队列正在处理中 */
  private processing = false
  /** 队列错误信息 */
  private error?: UploadError
  /** 队列并发标记 */
  private concurrentTicket = 1
  /** 用户传入的任务 */
  private tasks: Task[] = []
  /** 动态创建任务方法 */
  private tasksCreator?: TaskCreator
  /** 通过 tasksCreator 动态创建的任务 */
  private dynamicTasks: Task[] = []
  /** 任务的状态表 */
  private taskStates = new Map<Task, TaskState>()

  /** 状态订阅函数表 */
  private errorListeners = new Map<string, OnError>()
  private cancelListeners = new Map<string, OnCancel>()
  private progressListeners = new Map<string, OnProgress>()
  private completeListeners = new Map<string, OnComplete>()

  constructor(private options?: TaskQueueOptions) {
    this.tasksCreator = options?.tasksCreator
    this.concurrentTicket = options?.concurrentLimit || 1
    this.logger = new Logger(options?.logger?.level, options?.logger?.prefix)
  }

  // ==================== 公共 API ====================

  /** 添加任务 */
  enqueue(...tasks: Task[]) {
    if (this.processing) throw new Error('task is processing')
    // 清空现有任务并设置新的任务
    this.tasks.splice(0, Infinity)
    this.tasks.push(...tasks)
  }

  /** 开始处理 */
  async start(): Promise<Result> {
    this.logger.info('--------------------------')
    this.logger.info('Start processing the queue')

    return new Promise(resolve => {
      if (this.processing) {
        this.logger.error('Queue exited because its processing')
        return resolve({ error: new UploadError('InternalError', 'Task is processing') })
      }

      // 初始化全局状态
      this.canceled = false
      this.processing = true
      this.error = undefined
      this.taskStates.clear()
      this.concurrentTicket = this.options?.concurrentLimit || 1
      this.logger.info('Initialize queue status')

      // 任务状态和 start 函数返回绑定
      this.onComplete(() => {
        resolve({ result: true })
        this.logger.info('Queue is complete')
      })
      this.onCancel(() => {
        resolve({ canceled: true })
        this.logger.info('Queue is canceled')
      })
      this.onError(() => {
        resolve({ error: this.error! })
        this.logger.error(`Queue has error: ${this.error?.message}`)
      })

      // 如果队列有任务创建方法则执行创建
      if (this.tasksCreator) {
        this.logger.info('Call tasksCreator')
        this.dynamicTasks.splice(0, Infinity)
        this.tasksCreator().then(result => {
          if (isSuccessResult(result)) {
            this.logger.info('TasksCreator execution successful')
            this.dynamicTasks.push(...result.result)
            this.processNextTask()
          }

          if (isErrorResult(result)) {
            this.logger.info(`TasksCreator execution has error: ${result.error.message}`)
            this.error = result.error
            this.handleError()
          }

          this.logger.info('TasksCreator execution completed')
        })

        return
      }

      // 开始处理任务
      this.processNextTask()
    })
  }

  /** 取消任务 */
  async cancel(): Promise<Result> {
    this.logger.info('Cancel the queue')
    const cancelPromises: Array<Promise<any>> = []
    for (const task of [...this.tasks, ...this.dynamicTasks]) {
      const state = this.getTaskState(task)
      const shouldCanceled = ['processing']
      if (shouldCanceled.includes(state.status)) {
        cancelPromises.push(task.cancel())
      }
    }

    this.logger.info(`Cancel ${cancelPromises.length} tasks in the queue`)
    const result = await Promise.all(cancelPromises)
    this.processing = false
    for (const cancelItem of result) {
      if (!isSuccessResult(cancelItem)) {
        return cancelItem
      }
    }

    this.logger.info('Cancel completed')
    this.canceled = true
    return { result: true }
  }

  /** 作为 Task 接口使用；桥接 start 并转发进度通知 */
  async process(notice: ProgressNotice): Promise<Result> {
    const cleanListener = this.onProgress(notice)
    const result = await this.start()
    cleanListener()
    return result
  }

  // ==================== 事件订阅 ====================

  onProgress(listener: OnProgress) {
    const uuid = generateRandomString()
    this.progressListeners.set(uuid, listener)
    return () => this.progressListeners.delete(uuid)
  }

  onComplete(listener: OnComplete) {
    const uuid = generateRandomString()
    this.completeListeners.set(uuid, listener)
    return () => this.completeListeners.delete(uuid)
  }

  onError(listener: OnError) {
    const uuid = generateRandomString()
    this.errorListeners.set(uuid, listener)
    return () => this.errorListeners.delete(uuid)
  }

  onCancel(listener: OnCancel) {
    const uuid = generateRandomString()
    this.cancelListeners.set(uuid, listener)
    return () => this.cancelListeners.delete(uuid)
  }

  // ==================== 内部调度 ====================

  /** 调度函数；从队列中取出等待中的任务并分发执行，或判断队列是否全部完成 */
  private processNextTask() {
    if (this.canceled) {
      this.logger.info('Process exited because canceled')
      return
    }

    const allTasks = [...this.tasks, ...this.dynamicTasks]
    const waitingTasks = allTasks.filter(task => {
      const state = this.getTaskState(task)
      return state.status === 'waiting'
    })

    this.logger.info(`There are now ${waitingTasks.length} tasks in waiting`)
    this.logger.info(`There are now ${this.concurrentTicket} concurrency limit`)

    // 根据 concurrentLimit 取出任务并执行
    if (waitingTasks.length > 0 && this.concurrentTicket > 0) {
      const pendingTasks = waitingTasks.slice(0, this.concurrentTicket)
      this.logger.info(`${pendingTasks.length} tasks were called up`)
      for (let index = 0; index < pendingTasks.length; index++) {
        this.processTask(pendingTasks[index])
      }
      return
    }

    // 所有任务完成则触发 complete 事件
    const completedTasks = allTasks.filter(task => {
      const state = this.getTaskState(task)
      return state.status === 'success'
    })

    if (completedTasks.length === allTasks.length) {
      this.handleComplete()
    }
  }

  /** 执行单个任务；处理结果后继续调度下一个任务 */
  private async processTask(paddingTask: Task) {
    if (this.canceled) {
      this.logger.info('Process exited because canceled')
      return
    }

    this.logger.info('In process with padding task')
    if (this.concurrentTicket === 0) {
      this.logger.info('Process exited because concurrentTicket is 0')
      return
    }

    const state = this.getTaskState(paddingTask)

    this.concurrentTicket -= 1
    state.status = 'processing'

    const progressChange = () => this.handleProgress()
    const result = await paddingTask.process(progressChange)
    this.logger.info(`Task is resolved ${JSON.stringify(result)}`)
    this.concurrentTicket += 1

    if (isCanceledResult(result)) {
      state.status = 'canceled'
      this.handleCancel()
      return
    }

    if (isSuccessResult(result)) {
      state.status = 'success'
      this.handleProgress()
      this.processNextTask()
      return
    }

    if (isErrorResult(result)) {
      state.status = 'error'
      this.error = result.error
      // 网络错误，等待一定时间后重试
      if (result.error.name === 'NetworkError') {
        // 原本 1 次 + 重试 2 次 = 总计 3 次
        if (state.retryCount < 2) {
          state.retryCount++
          await delay(2000)
          this.processTask(paddingTask)
          return
        }
      }

      this.handleError()
      this.cancel()
    }

    this.logger.error('Unknown task execution status')
  }

  // ==================== 内部工具 ====================

  private getTaskState(task: Task): TaskState {
    const state = this.taskStates.get(task)
    if (state == null) {
      const initState: TaskState = { status: 'waiting', retryCount: 0 }
      this.taskStates.set(task, initState)
    }
    return this.taskStates.get(task)!
  }

  private handleProgress() {
    const progressListenerList = [...this.progressListeners.values()]
    for (let index = 0; index < progressListenerList.length; index++) {
      const progressListener = progressListenerList[index]
      if (progressListener) progressListener()
    }
  }

  private handleComplete() {
    const completeListenerList = [...this.completeListeners.values()]
    for (let index = 0; index < completeListenerList.length; index++) {
      const completeListener = completeListenerList[index]
      if (completeListener) completeListener()
    }
    this.processing = false
  }

  private handleError() {
    const errorListenerList = [...this.errorListeners.values()]
    for (let index = 0; index < errorListenerList.length; index++) {
      const errorListener = errorListenerList[index]
      if (errorListener) errorListener()
    }
    this.processing = false
  }

  private handleCancel() {
    const cancelListenerList = [...this.cancelListeners.values()]
    for (let index = 0; index < cancelListenerList.length; index++) {
      const cancelListener = cancelListenerList[index]
      if (cancelListener) cancelListener()
    }
    this.processing = false
  }
}
