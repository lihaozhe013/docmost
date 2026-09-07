import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createOllama } from 'ai-sdk-ollama';
import { LanguageModel } from 'ai';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { EnvironmentService } from '../environment/environment.service';

@Injectable()
export class AiPageEditingModelFactory {
  constructor(private readonly environmentService: EnvironmentService) {}

  create(): LanguageModel {
    const driver = this.environmentService.getAiDriver()?.toLowerCase();
    const modelId = this.environmentService.getAiChatModel();

    if (!driver || !modelId) {
      throw new ServiceUnavailableException(
        'AI page editing is not configured. Set AI_DRIVER and AI_CHAT_MODEL or AI_COMPLETION_MODEL.'
      );
    }

    switch (driver) {
      case 'openai': {
        const provider = createOpenAI({
          apiKey: this.environmentService.getOpenAiApiKey(),
          baseURL: this.environmentService.getOpenAiApiUrl() || undefined
        });
        return provider.chat(modelId);
      }
      case 'openai-compatible': {
        const provider = createOpenAICompatible({
          name: 'docmost-openai-compatible',
          baseURL: this.environmentService.getOpenAiApiUrl(),
          apiKey: this.environmentService.getOpenAiApiKey()
        });
        return provider.chatModel(modelId);
      }
      case 'gemini': {
        const provider = createGoogleGenerativeAI({
          apiKey: this.environmentService.getGeminiApiKey()
        });
        return provider(modelId);
      }
      case 'ollama': {
        const provider = createOllama({
          baseURL: this.environmentService.getOllamaApiUrl()
        });
        return provider(modelId);
      }
      default:
        throw new ServiceUnavailableException(
          `Unsupported AI driver: ${driver}`
        );
    }
  }
}
