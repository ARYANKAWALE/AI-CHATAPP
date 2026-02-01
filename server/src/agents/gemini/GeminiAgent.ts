import { GoogleGenAI } from "@google/genai";
import type { Channel, Event, StreamChat } from "stream-chat";
import type { AIAgent } from "../types";
import { GeminiResponseHandler } from "./GeminiResponseHandler";

export class GeminiAgent implements AIAgent {
  private genai?: GoogleGenAI;
  private lastInteractionTs = Date.now();
  private chatHistory: { role: string; parts: { text: string }[] }[] = [];
  private handlers: GeminiResponseHandler[] = [];
  private isProcessing = false; // Prevent concurrent API calls
  private lastApiCallTs = 0; // Track last API call time
  private apiCallCount = 0; // Track total API calls for debugging
  private messageQueue: Event[] = []; // Queue messages while processing

  constructor(
    readonly chatClient: StreamChat,
    readonly channel: Channel,
  ) {}

  dispose = async () => {
    this.chatClient.off("message.new", this.handleMessage);
    await this.chatClient.disconnectUser();
    this.handlers.forEach((handler) => handler.dispose());
    this.handlers = [];
    this.isProcessing = false;
    this.messageQueue = [];
  };

  get user() {
    return this.chatClient.user;
  }

  get client() {
    return this.chatClient;
  }

  getLastInteraction = (): number => this.lastInteractionTs;

  init = async () => {
    const apiKey = process.env.GOOGLE_API_KEY as string | undefined;
    if (!apiKey) {
      throw new Error("Google API key is required (GOOGLE_API_KEY)");
    }

    this.genai = new GoogleGenAI({ apiKey });
    this.chatClient.on("message.new", this.handleMessage);
    console.log("[GeminiAgent] Initialized and listening for messages");
  };

  private getSystemPrompt = (context?: string): string => {
    const currentDate = new Date().toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    return `You are an expert AI Writing Assistant. Your primary purpose is to be a collaborative writing partner.

**Your Core Capabilities:**
- Content Creation, Improvement, Style Adaptation, Brainstorming, and Writing Coaching.
- **Current Date**: Today's date is ${currentDate}. Please use this for any time-sensitive queries.

**Response Format:**
- Be direct and production-ready.
- Use clear formatting with markdown when appropriate.
- Never begin responses with phrases like "Here's the edit:", "Here are the changes:", or similar introductory statements.
- Provide responses directly and professionally without unnecessary preambles.

**Writing Context**: ${context || "General writing assistance."}

Your goal is to provide accurate, current, and helpful written content.`;
  };

  private handleMessage = async (e: Event) => {
    if (!this.genai) {
      console.log("[GeminiAgent] Gemini not initialized, skipping");
      return;
    }

    // Skip messages from the bot itself
    if (e.user?.id === this.chatClient.user?.id) {
      return;
    }

    if (!e.message || (e.message as any).ai_generated) {
      return;
    }

    const message = e.message.text;
    if (!message) return;

    console.log(
      `[GeminiAgent] Received message: "${message.substring(0, 50)}..." from user: ${e.user?.id}`,
    );

    // If already processing, queue the message instead of firing another API call
    if (this.isProcessing) {
      console.log(
        `[GeminiAgent] Already processing a message, queuing this one`,
      );
      this.messageQueue.push(e);
      return;
    }

    await this.processMessage(e);

    // Process any queued messages one by one
    while (this.messageQueue.length > 0) {
      const nextEvent = this.messageQueue.shift()!;
      console.log(
        `[GeminiAgent] Processing queued message (${this.messageQueue.length} remaining)`,
      );
      await this.processMessage(nextEvent);
    }
  };

  private processMessage = async (e: Event) => {
    if (!this.genai) return;

    this.isProcessing = true;
    this.lastInteractionTs = Date.now();

    const message = e.message!.text!;
    const writingTask = ((e.message as any).custom as { writingTask?: string })
      ?.writingTask;
    const context = writingTask ? `Writing Task: ${writingTask}` : undefined;
    const systemPrompt = this.getSystemPrompt(context);

    // Add user message to chat history
    this.chatHistory.push({
      role: "user",
      parts: [{ text: message }],
    });

    // Send empty AI message to channel
    const { message: channelMessage } = await this.channel.sendMessage({
      text: "",
      ai_generated: true,
    } as any);

    // Send thinking indicator
    await this.channel.sendEvent({
      type: "ai_indicator.update",
      ai_state: "AI_STATE_THINKING",
      cid: channelMessage.cid,
      message_id: channelMessage.id,
    });

    // Rate limit: ensure at least 4 seconds between API calls
    const timeSinceLastCall = Date.now() - this.lastApiCallTs;
    if (timeSinceLastCall < 4000 && this.lastApiCallTs > 0) {
      const waitTime = 4000 - timeSinceLastCall;
      console.log(
        `[GeminiAgent] Rate limiting: waiting ${waitTime}ms before API call`,
      );
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }

    // Send generating indicator
    await this.channel.sendEvent({
      type: "ai_indicator.update",
      ai_state: "AI_STATE_GENERATING",
      cid: channelMessage.cid,
      message_id: channelMessage.id,
    });

    try {
      this.apiCallCount++;
      this.lastApiCallTs = Date.now();
      console.log(
        `[GeminiAgent] API call #${this.apiCallCount} with ${this.chatHistory.length} messages in history`,
      );

      // Call Gemini with streaming, with retry for rate limits
      let response: any;
      const maxRetries = 3;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          response = await this.genai.models.generateContentStream({
            model: "gemini-2.5-flash",
            contents: this.chatHistory,
            config: {
              systemInstruction: systemPrompt,
              temperature: 0.7,
            },
          });
          break; // Success, exit retry loop
        } catch (retryError: any) {
          const errorMessage = retryError?.message || String(retryError);
          const isRateLimit =
            errorMessage.includes("429") ||
            errorMessage.includes("quota") ||
            errorMessage.includes("Too Many Requests");
          if (isRateLimit && attempt < maxRetries) {
            const delay = Math.pow(2, attempt + 1) * 1000; // 2s, 4s, 8s
            console.log(
              `[GeminiAgent] Rate limited (attempt ${attempt + 1}/${maxRetries}), retrying in ${delay}ms...`,
            );
            await new Promise((resolve) => setTimeout(resolve, delay));
          } else {
            throw retryError; // Not a rate limit or max retries exhausted
          }
        }
      }

      console.log(
        `[GeminiAgent] Gemini stream started, processing response...`,
      );

      const handler = new GeminiResponseHandler(
        response,
        this.chatClient,
        this.channel,
        channelMessage,
        () => this.removeHandler(handler),
      );
      this.handlers.push(handler);

      const fullText = await handler.run();
      console.log(
        `[GeminiAgent] Response complete, length: ${fullText?.length || 0}`,
      );

      // Add assistant response to chat history
      if (fullText) {
        this.chatHistory.push({
          role: "model",
          parts: [{ text: fullText }],
        });
      }
    } catch (error: any) {
      console.error(
        "[GeminiAgent] Error calling Gemini:",
        error?.message || error,
      );
      try {
        await this.channel.sendEvent({
          type: "ai_indicator.update",
          ai_state: "AI_STATE_ERROR",
          cid: channelMessage.cid,
          message_id: channelMessage.id,
        });
        await this.chatClient.partialUpdateMessage(channelMessage.id, {
          set: {
            text: "Sorry, I encountered an error. Please try again.",
          },
        });
      } catch (updateError) {
        console.error(
          "[GeminiAgent] Failed to update error message:",
          updateError,
        );
      }
    } finally {
      this.isProcessing = false;
    }
  };

  private removeHandler = (handlerToRemove: GeminiResponseHandler) => {
    this.handlers = this.handlers.filter(
      (handler) => handler !== handlerToRemove,
    );
  };
}
