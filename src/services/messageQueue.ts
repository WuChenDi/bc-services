import { Bot } from 'grammy';
import { sleep } from '@/utils';

export interface QueuedMessage {
  id: string;
  chatId: string;
  content: string;
  parseMode?: 'Markdown' | 'HTML';
  type: 'text' | 'dice';
  sequenceId: number; // 严格的序列号控制
  retries?: number;
  timestamp: number;
  isBlocking?: boolean; // 是否阻塞后续消息
}

export interface DiceMessage extends QueuedMessage {
  type: 'dice';
  playerType: string;
  cardIndex: number;
  onDiceResult?: (value: number) => Promise<void> | void;
}

export class MessageQueueService {
  private queue: QueuedMessage[] = [];
  private processing: boolean = false;
  private readonly maxRetries = 3;
  private readonly messageDelay = 1200; // 消息间固定间隔
  private readonly diceDelay = 5000; // 骰子动画等待时间
  private messageCounter = 0;
  private sequenceCounter = 0;
  private currentGameId: string | null = null;

  constructor(private bot: Bot) {}

  /**
   * 设置当前游戏ID，用于消息序列控制
   */
  setCurrentGame(gameId: string): void {
    this.currentGameId = gameId;
    this.sequenceCounter = 0; // 重置序列计数器
    console.log(`Message queue: New game ${gameId}, sequence reset`);
  }

  /**
   * 添加文本消息到队列
   */
  async enqueueMessage(
    chatId: string, 
    content: string, 
    isBlocking: boolean = false,
    parseMode: 'Markdown' | 'HTML' = 'Markdown'
  ): Promise<string> {
    const id = `msg_${++this.messageCounter}_${Date.now()}`;
    const sequenceId = ++this.sequenceCounter;
    
    const message: QueuedMessage = {
      id,
      chatId,
      content,
      parseMode,
      type: 'text',
      sequenceId,
      retries: 0,
      timestamp: Date.now(),
      isBlocking
    };

    this.addToQueue(message);
    
    // 如果是阻塞消息，等待处理完成
    if (isBlocking) {
      await this.waitForMessage(id);
    }
    
    return id;
  }

  /**
   * 添加骰子消息到队列（总是阻塞的）
   */
  async enqueueDice(
    chatId: string, 
    playerType: string, 
    cardIndex: number
  ): Promise<number> {
    return new Promise(async (resolve, reject) => {
      const id = `dice_${++this.messageCounter}_${Date.now()}`;
      const sequenceId = ++this.sequenceCounter;
      
      const diceMessage: DiceMessage = {
        id,
        chatId,
        content: '',
        type: 'dice',
        playerType,
        cardIndex,
        sequenceId,
        retries: 0,
        timestamp: Date.now(),
        isBlocking: true,
        onDiceResult: async (value: number) => {
          resolve(value);
        }
      };

      this.addToQueue(diceMessage);
      
      // 等待骰子处理完成
      await this.waitForMessage(id);

      // 超时处理
      setTimeout(() => {
        reject(new Error(`Dice timeout for ${playerType} card ${cardIndex}`));
      }, 20000);
    });
  }

  /**
   * 清空队列并重置状态
   */
  clearQueue(): void {
    console.log(`Clearing message queue with ${this.queue.length} messages`);
    this.queue = [];
    this.processing = false;
    this.sequenceCounter = 0;
  }

  /**
   * 获取队列状态
   */
  getQueueStatus(): {
    queueLength: number;
    processing: boolean;
    currentSequence: number;
    currentGame: string | null;
  } {
    return {
      queueLength: this.queue.length,
      processing: this.processing,
      currentSequence: this.sequenceCounter,
      currentGame: this.currentGameId
    };
  }

  /**
   * 等待特定消息处理完成
   */
  private async waitForMessage(messageId: string): Promise<void> {
    return new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        const messageExists = this.queue.some(msg => msg.id === messageId);
        if (!messageExists && !this.processing) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 100);

      // 10秒超时
      setTimeout(() => {
        clearInterval(checkInterval);
        resolve();
      }, 10000);
    });
  }

  /**
   * 将消息添加到队列并严格按序列号排序
   */
  private addToQueue(message: QueuedMessage): void {
    this.queue.push(message);
    
    // 严格按序列号排序，确保顺序
    this.queue.sort((a, b) => a.sequenceId - b.sequenceId);

    console.log(`Message queued: ${message.id}, sequence: ${message.sequenceId}, queue length: ${this.queue.length}`);
    
    // 立即开始处理队列
    this.processQueue();
  }

  /**
   * 处理队列 - 严格按序列号顺序处理
   */
  private async processQueue(): Promise<void> {
    if (this.processing) {
      return;
    }

    this.processing = true;
    console.log(`Starting sequential queue processing with ${this.queue.length} messages`);

    while (this.queue.length > 0) {
      // 取出序列号最小的消息
      const message = this.queue.shift()!;
      
      try {
        console.log(`Processing message: ${message.id}, sequence: ${message.sequenceId}, type: ${message.type}`);
        
        await this.processMessage(message);
        
        // 固定延迟，确保消息不会太快
        await sleep(this.messageDelay);
        
      } catch (error) {
        console.error(`Failed to process message ${message.id}:`, error);
        await this.handleMessageError(message, error);
      }
    }

    this.processing = false;
    console.log('Sequential queue processing completed');
  }

  /**
   * 处理单个消息
   */
  private async processMessage(message: QueuedMessage): Promise<void> {
    if (message.type === 'text') {
      await this.processTextMessage(message);
    } else if (message.type === 'dice') {
      await this.processDiceMessage(message as DiceMessage);
    }
  }

  /**
   * 处理文本消息
   */
  private async processTextMessage(message: QueuedMessage): Promise<void> {
    try {
      await this.bot.api.sendMessage(message.chatId, message.content, {
        parse_mode: message.parseMode
      });
      console.log(`✅ Text message sent: ${message.id}`);
    } catch (error) {
      console.error(`❌ Text message failed: ${message.id}`, error);
      throw error;
    }
  }

  /**
   * 处理骰子消息
   */
  private async processDiceMessage(diceMessage: DiceMessage): Promise<void> {
    try {
      console.log(`🎲 Rolling dice for ${diceMessage.playerType} card ${diceMessage.cardIndex}`);
      
      // 第一步：发送骰子
      const diceResult = await this.bot.api.sendDice(diceMessage.chatId, '🎲');
      const diceValue = diceResult.dice?.value;

      if (!diceValue || diceValue < 1 || diceValue > 6) {
        throw new Error(`Invalid dice value: ${diceValue}`);
      }

      console.log(`🎲 Dice animation started, value: ${diceValue}`);

      // 第二步：等待骰子动画完成
      await sleep(this.diceDelay);

      // 第三步：发送结果消息
      const playerText = diceMessage.playerType === 'banker' ? '🏦 庄家' : '👤 闲家';
      const resultMessage = `🎯 **${playerText}第${diceMessage.cardIndex}张牌开出：${diceValue} 点**`;
      
      await this.bot.api.sendMessage(diceMessage.chatId, resultMessage, {
        parse_mode: 'Markdown'
      });

      console.log(`✅ Dice process completed: ${diceMessage.id}, value: ${diceValue}`);

      // 第四步：调用回调
      if (diceMessage.onDiceResult) {
        await diceMessage.onDiceResult(diceValue);
      }
      
    } catch (error) {
      console.error(`❌ Dice message error: ${diceMessage.id}`, error);
      
      // 骰子失败时使用随机值
      const fallbackValue = Math.floor(Math.random() * 6) + 1;
      console.log(`🎲 Using fallback value: ${fallbackValue}`);
      
      try {
        const playerText = diceMessage.playerType === 'banker' ? '🏦 庄家' : '👤 闲家';
        const fallbackMessage = 
          `⚠️ **${playerText}第${diceMessage.cardIndex}张牌**\n` +
          `🎲 骰子发送失败，系统随机开出：**${fallbackValue} 点**\n` +
          `💡 游戏继续进行...`;
        
        await this.bot.api.sendMessage(diceMessage.chatId, fallbackMessage, {
          parse_mode: 'Markdown'
        });

        if (diceMessage.onDiceResult) {
          await diceMessage.onDiceResult(fallbackValue);
        }
      } catch (fallbackError) {
        console.error(`❌ Fallback message also failed:`, fallbackError);
        // 最终兜底：直接调用回调
        if (diceMessage.onDiceResult) {
          await diceMessage.onDiceResult(fallbackValue);
        }
      }
    }
  }

  /**
   * 处理消息错误
   */
  private async handleMessageError(message: QueuedMessage, error: any): Promise<void> {
    message.retries = (message.retries || 0) + 1;

    if (message.retries < this.maxRetries) {
      console.log(`🔄 Retrying message ${message.id}, attempt ${message.retries + 1}`);
      
      // 重新加入队列，保持原序列号
      this.queue.push(message);
      this.queue.sort((a, b) => a.sequenceId - b.sequenceId);
      
      // 延迟后重试
      await sleep(1000 * message.retries);
      
    } else {
      console.error(`💀 Message ${message.id} failed after ${this.maxRetries} attempts:`, error);
      
      // 如果是骰子消息，必须调用回调防止卡住
      if (message.type === 'dice') {
        const diceMessage = message as DiceMessage;
        if (diceMessage.onDiceResult) {
          const fallbackValue = Math.floor(Math.random() * 6) + 1;
          console.log(`🎲 Final fallback for ${diceMessage.id}: ${fallbackValue}`);
          await diceMessage.onDiceResult(fallbackValue);
        }
      }
    }
  }
}
