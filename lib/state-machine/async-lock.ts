/**
 * Promise-based 异步排他锁
 *
 * 防止并发 getNumber 调用创建多个 Activation 并扣费。
 * 默认 30s 超时自动释放，保证挂起的 getNumber 不会永久阻塞队列。
 */
export class AsyncLock {
  private locked = false;
  private queue: Array<() => void> = [];

  /**
   * 获取锁
   * @param timeoutMs 超时毫秒数，默认 30000（30s）
   * @returns true 表示成功获取锁，false 表示超时
   */
  async acquire(timeoutMs = 30000): Promise<boolean> {
    if (!this.locked) {
      this.locked = true;
      return true;
    }

    return new Promise<boolean>((resolve) => {
      let settled = false;

      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          console.warn('[AsyncLock] acquire 超时 (30s)，强制释放');
          resolve(false);
        }
      }, timeoutMs);

      this.queue.push(() => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          this.locked = true;
          resolve(true);
        }
      });
    });
  }

  /**
   * 释放锁
   * 若有等待者，按 FIFO 顺序唤醒下一个
   */
  release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      next();
    } else {
      this.locked = false;
    }
  }

  /** 检查锁当前是否被持有 */
  get isLocked(): boolean {
    return this.locked;
  }
}
