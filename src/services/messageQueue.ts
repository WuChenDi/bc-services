import { Bot } from 'grammy';
import { sleep } from '@/utils';

export interface QueuedMessage {
  id: string;
  chatId: string;
  content: string;
  parseMode?: 'Markdown' | 'HTML';
  type: 'text' | 'dice';
  priority: number; // 优先级：1=最高，5=最低
  retries?: number;
  timestamp: number;
}

export interface DiceMessage extends QueuedMessage {
  type: 'dice';
  playerType: string;
  cardIndex: number;
  onDiceResult?: (value: number) => void;
}

export class MessageQueueService {
  private queue: QueuedMessage[] = [];
  private processing: boolean = false;
  private readonly maxRetries = 3;
  private readonly baseDelay = 1000; // 基础延迟 1 秒
  private readonly maxDelay = 5000;  // 最大延迟 5 秒
  private messageCounter = 0;

  constructor(private bot: Bot) { }

  /**
   * 添加文本消息到队列
   */
  enqueueMessage(
    chatId: string,
    content: string,
    priority: number = 3,
    parseMode: 'Markdown' | 'HTML' = 'Markdown'
  ): string {
    const id = `msg_${++this.messageCounter}_${Date.now()}`;

    const message: QueuedMessage = {
      id,
      chatId,
      content,
      parseMode,
      type: 'text',
      priority,
      retries: 0,
      timestamp: Date.now()
    };

    this.addToQueue(message);
    this.processQueue();

    return id;
  }

  /**
   * 添加骰子消息到队列
   */
  enqueueDice(
    chatId: string,
    playerType: string,
    cardIndex: number,
    priority: number = 2
  ): Promise<number> {
    return new Promise((resolve, reject) => {
      const id = `dice_${++this.messageCounter}_${Date.now()}`;

      const diceMessage: DiceMessage = {
        id,
        chatId,
        content: '', // 骰子消息不需要文本内容
        type: 'dice',
        playerType,
        cardIndex,
        priority,
        retries: 0,
        timestamp: Date.now(),
        onDiceResult: resolve
      };

      this.addToQueue(diceMessage);
      this.processQueue();

      // 超时处理
      setTimeout(() => {
        reject(new Error('Dice timeout'));
      }, 15000);
    });
  }

  /**
   * 添加多个消息（批量操作）
   */
  enqueueMessages(messages: Array<{
    chatId: string;
    content: string;
    priority?: number;
    parseMode?: 'Markdown' | 'HTML';
  }>): string[] {
    const ids: string[] = [];

    messages.forEach(msg => {
      const id = this.enqueueMessage(
        msg.chatId,
        msg.content,
        msg.priority || 3,
        msg.parseMode || 'Markdown'
      );
      ids.push(id);
    });

    return ids;
  }

  /**
   * 清空队列（紧急情况使用）
   */
  clearQueue(): void {
    console.log(`Clearing message queue with ${this.queue.length} messages`);
    this.queue = [];
  }

  /**
   * 获取队列状态
   */
  getQueueStatus(): {
    queueLength: number;
    processing: boolean;
    oldestMessage?: number;
  } {
    const oldestMessage = this.queue.length > 0 && this.queue[0]
      ? Date.now() - this.queue[0].timestamp
      : undefined;

    return {
      queueLength: this.queue.length,
      processing: this.processing,
      oldestMessage
    };
  }

  /**
   * 将消息添加到队列并排序
   */
  private addToQueue(message: QueuedMessage): void {
    this.queue.push(message);

    // 按优先级和时间戳排序
    this.queue.sort((a, b) => {
      if (a.priority !== b.priority) {
        return a.priority - b.priority; // 优先级低的数字优先
      }
      return a.timestamp - b.timestamp; // 时间早的优先
    });

    console.log(`Message queued: ${message.id}, queue length: ${this.queue.length}`);
  }

  /**
   * 处理队列
   */
  private async processQueue(): Promise<void> {
    if (this.processing || this.queue.length === 0) {
      return;
    }

    this.processing = true;
    console.log(`Starting queue processing with ${this.queue.length} messages`);

    while (this.queue.length > 0) {
      const message = this.queue.shift()!;

      try {
        await this.processMessage(message);

        // 消息间隔，防止 Telegram API 限流
        await sleep(this.calculateDelay(message));

      } catch (error) {
        console.error(`Failed to process message ${message.id}:`, error);
        await this.handleMessageError(message, error);
      }
    }

    this.processing = false;
    console.log('Queue processing completed');
  }

  /**
   * 处理单个消息
   */
  private async processMessage(message: QueuedMessage): Promise<void> {
    console.log(`Processing message: ${message.id}, type: ${message.type}`);

    if (message.type === 'text') {
      await this.bot.api.sendMessage(message.chatId, message.content, {
        parse_mode: message.parseMode
      });
      console.log(`Text message sent: ${message.id}`);

    } else if (message.type === 'dice') {
      const diceMessage = message as DiceMessage;
      await this.processDiceMessage(diceMessage);
    }
  }

  /**
   * 处理骰子消息
   */
  private async processDiceMessage(diceMessage: DiceMessage): Promise<void> {
    try {
      console.log(`Rolling dice for ${diceMessage.playerType} card ${diceMessage.cardIndex}`);

      // 发送骰子
      const diceResult = await this.bot.api.sendDice(diceMessage.chatId, '🎲');
      const diceValue = diceResult.dice?.value;

      if (!diceValue || diceValue < 1 || diceValue > 6) {
        throw new Error(`Invalid dice value: ${diceValue}`);
      }

      console.log(`Dice sent successfully: ${diceValue}`);

      // 等待骰子动画
      await sleep(4000);

      // 发送结果消息
      const playerText = diceMessage.playerType === 'banker' ? '🏦 庄家' : '👤 闲家';
      const resultMessage = `🎯 **${playerText}第${diceMessage.cardIndex}张牌开出：${diceValue} 点**`;

      await this.bot.api.sendMessage(diceMessage.chatId, resultMessage, {
        parse_mode: 'Markdown'
      });

      // 调用回调
      if (diceMessage.onDiceResult) {
        diceMessage.onDiceResult(diceValue);
      }

      console.log(`Dice process completed: ${diceMessage.id}`);

    } catch (error) {
      console.error(`Dice message error: ${diceMessage.id}`, error);

      // 如果骰子失败，使用随机值
      const fallbackValue = Math.floor(Math.random() * 6) + 1;

      const playerText = diceMessage.playerType === 'banker' ? '🏦 庄家' : '👤 闲家';
      const fallbackMessage =
        `⚠️ **${playerText}第${diceMessage.cardIndex}张牌**\n` +
        `🎲 骰子发送失败，系统随机开出：**${fallbackValue} 点**\n` +
        `💡 游戏继续进行...`;

      await this.bot.api.sendMessage(diceMessage.chatId, fallbackMessage, {
        parse_mode: 'Markdown'
      });

      if (diceMessage.onDiceResult) {
        diceMessage.onDiceResult(fallbackValue);
      }
    }
  }

  /**
   * 计算消息延迟
   */
  private calculateDelay(message: QueuedMessage): number {
    // 骰子消息需要更长的延迟
    if (message.type === 'dice') {
      return 1500;
    }

    // 高优先级消息延迟更短
    if (message.priority <= 2) {
      return 800;
    }

    return this.baseDelay;
  }

  /**
   * 处理消息错误
   */
  private async handleMessageError(message: QueuedMessage, error: any): Promise<void> {
    message.retries = (message.retries || 0) + 1;

    if (message.retries < this.maxRetries) {
      console.log(`Retrying message ${message.id}, attempt ${message.retries + 1}`);

      // 重新加入队列，降低优先级
      message.priority = Math.min(message.priority + 1, 5);
      message.timestamp = Date.now();

      this.addToQueue(message);

      // 延迟后重试
      await sleep(Math.min(1000 * message.retries, this.maxDelay));

    } else {
      console.error(`Message ${message.id} failed after ${this.maxRetries} attempts:`, error);

      // 如果是骰子消息，需要调用回调防止卡住
      if (message.type === 'dice') {
        const diceMessage = message as DiceMessage;
        if (diceMessage.onDiceResult) {
          const fallbackValue = Math.floor(Math.random() * 6) + 1;
          diceMessage.onDiceResult(fallbackValue);
        }
      }
    }
  }
}
