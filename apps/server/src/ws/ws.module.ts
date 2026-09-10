import { Global, Module } from '@nestjs/common';
import { WsGateway } from './ws.gateway';
import { WsService } from './ws.service';
import { WsTreeService } from './ws-tree.service';
import { TokenModule } from '../core/auth/token.module';
import { BaseRealtimeBridge } from './base-realtime.bridge';
import { AiPageEditingService } from '../integrations/ai-page-editing/ai-page-editing.service';
import { AiPageEditingImageService } from '../integrations/ai-page-editing/ai-page-editing-image.service';
import { AgentRuntime } from '../integrations/ai-page-editing/agent-runtime';
import { OpenAiResponsesClientFactory } from '../integrations/ai-page-editing/model';

@Global()
@Module({
  imports: [TokenModule],
  providers: [
    WsGateway,
    WsService,
    WsTreeService,
    BaseRealtimeBridge,
    AiPageEditingService,
    AiPageEditingImageService,
    AgentRuntime,
    OpenAiResponsesClientFactory
  ],
  exports: [WsGateway, WsService, WsTreeService]
})
export class WsModule {}
