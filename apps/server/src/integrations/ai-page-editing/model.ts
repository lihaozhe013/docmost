import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { EnvironmentService } from '../environment/environment.service';
import {
  createOpenAiResponsesClient,
  OpenAiResponsesHttpClient
} from './responses-client';

@Injectable()
export class OpenAiResponsesClientFactory {
  constructor(private readonly environmentService: EnvironmentService) {}

  create(): OpenAiResponsesHttpClient {
    const apiUrl = this.environmentService.getAiApiUrl();
    const apiKey = this.environmentService.getAiApiKey();
    const model = this.getModel();
    if (!apiUrl || !apiKey || !model) {
      throw new ServiceUnavailableException(
        'AI page editing is not configured. Set AI_API_URL, AI_API_KEY, and AI_MODEL.'
      );
    }

    return createOpenAiResponsesClient(apiUrl, apiKey);
  }

  getModel(): string {
    return this.environmentService.getAiModel();
  }
}
