import {
  Injectable,
  Logger,
  ServiceUnavailableException
} from '@nestjs/common';
import { EnvironmentService } from '../environment/environment.service';
import {
  createOpenAiResponsesClient,
  OpenAiResponsesHttpClient,
  redactResponsesEndpoint,
  resolveResponsesEndpoint
} from './responses-client';

@Injectable()
export class OpenAiResponsesClientFactory {
  private readonly logger = new Logger(OpenAiResponsesClientFactory.name);

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

    const endpoint = resolveResponsesEndpoint(apiUrl);
    this.logger.debug(
      `[ai_page_editing] provider endpoint resolved: ${redactResponsesEndpoint(endpoint)}`
    );
    return createOpenAiResponsesClient(endpoint, apiKey);
  }

  getModel(): string {
    return this.environmentService.getAiModel();
  }
}
