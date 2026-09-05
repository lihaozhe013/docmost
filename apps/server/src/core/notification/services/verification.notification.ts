import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import {
  IApprovalRejectedNotificationJob,
  IApprovalRequestedNotificationJob,
  IPageVerifiedNotificationJob,
  IVerificationExpiringNotificationJob,
  IVerificationExpiredNotificationJob,
} from '../../../integrations/queue/constants/queue.interface';
import { NotificationService } from '../notification.service';
import { NotificationType } from '../notification.constants';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';

@Injectable()
export class VerificationNotificationService {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly notificationService: NotificationService,
    private readonly spaceMemberRepo: SpaceMemberRepo,
    private readonly pagePermissionRepo: PagePermissionRepo,
  ) {}

  private async getAlreadyNotifiedUserIds(
    pageVerificationId: string,
    type: string,
  ): Promise<Set<string>> {
    const rows = await this.db
      .selectFrom('notifications')
      .select('userId')
      .where('pageVerificationId', '=', pageVerificationId)
      .where('type', '=', type)
      .execute();
    return new Set(rows.map((r) => r.userId));
  }

  private async filterAccessibleRecipients(
    userIds: string[],
    pageId: string,
    spaceId: string,
  ): Promise<string[]> {
    if (userIds.length === 0) return [];
    const inSpace = await this.spaceMemberRepo.getUserIdsWithSpaceAccess(
      userIds,
      spaceId,
    );
    if (inSpace.size === 0) return [];
    return this.pagePermissionRepo.getUserIdsWithPageAccess(pageId, [
      ...inSpace,
    ]);
  }

  async processVerificationExpiring(
    data: IVerificationExpiringNotificationJob,
  ) {
    const verification = await this.db
      .selectFrom('pageVerifications')
      .selectAll()
      .where('id', '=', data.verificationId)
      .executeTakeFirst();

    if (!verification) return;
    if (verification.type !== 'expiring') return;
    if (!verification.expiresAt) return;
    const expiresAtMs = new Date(verification.expiresAt).getTime();
    if (expiresAtMs <= Date.now()) return;

    const verifierRows = await this.db
      .selectFrom('pageVerifiers')
      .select('userId')
      .where('pageVerificationId', '=', verification.id)
      .execute();
    const verifierIds = verifierRows.map((r) => r.userId);
    if (verifierIds.length === 0) return;

    const accessibleVerifierIds = await this.filterAccessibleRecipients(
      verifierIds,
      verification.pageId,
      verification.spaceId,
    );
    if (accessibleVerifierIds.length === 0) return;

    const alreadyNotified = await this.getAlreadyNotifiedUserIds(
      verification.id,
      NotificationType.PAGE_VERIFICATION_EXPIRING,
    );
    const recipients = accessibleVerifierIds.filter(
      (id) => !alreadyNotified.has(id),
    );
    if (recipients.length === 0) return;

    const expiresAtIso = new Date(verification.expiresAt).toISOString();

    for (const userId of recipients) {
      await this.notificationService.create({
        userId,
        workspaceId: verification.workspaceId,
        type: NotificationType.PAGE_VERIFICATION_EXPIRING,
        pageId: verification.pageId,
        spaceId: verification.spaceId,
        pageVerificationId: verification.id,
        data: { expiresAt: expiresAtIso },
      });
    }
  }

  async processVerificationExpired(
    data: IVerificationExpiredNotificationJob,
  ) {
    const verification = await this.db
      .selectFrom('pageVerifications')
      .selectAll()
      .where('id', '=', data.verificationId)
      .executeTakeFirst();

    if (!verification) return;
    if (verification.type !== 'expiring') return;
    if (!verification.expiresAt) return;
    if (new Date(verification.expiresAt).getTime() > Date.now()) return;

    const verifierRows = await this.db
      .selectFrom('pageVerifiers')
      .select('userId')
      .where('pageVerificationId', '=', verification.id)
      .execute();
    const verifierIds = verifierRows.map((r) => r.userId);
    if (verifierIds.length === 0) return;

    const accessibleVerifierIds = await this.filterAccessibleRecipients(
      verifierIds,
      verification.pageId,
      verification.spaceId,
    );
    if (accessibleVerifierIds.length === 0) return;

    const alreadyNotified = await this.getAlreadyNotifiedUserIds(
      verification.id,
      NotificationType.PAGE_VERIFICATION_EXPIRED,
    );
    const recipients = accessibleVerifierIds.filter(
      (id) => !alreadyNotified.has(id),
    );
    if (recipients.length === 0) return;

    for (const userId of recipients) {
      await this.notificationService.create({
        userId,
        workspaceId: verification.workspaceId,
        type: NotificationType.PAGE_VERIFICATION_EXPIRED,
        pageId: verification.pageId,
        spaceId: verification.spaceId,
        pageVerificationId: verification.id,
      });
    }
  }

  async processPageVerified(data: IPageVerifiedNotificationJob) {
    const { verifierIds, pageId, spaceId, workspaceId, actorId } = data;
    if (verifierIds.length === 0) return;

    const accessibleVerifierIds = await this.filterAccessibleRecipients(
      verifierIds,
      pageId,
      spaceId,
    );
    if (accessibleVerifierIds.length === 0) return;

    for (const userId of accessibleVerifierIds) {
      await this.notificationService.create({
        userId,
        workspaceId,
        type: NotificationType.PAGE_VERIFIED,
        actorId,
        pageId,
        spaceId,
      });
    }
  }

  async processApprovalRequested(
    data: IApprovalRequestedNotificationJob,
  ) {
    const { verifierIds, pageId, spaceId, workspaceId, actorId } = data;
    if (verifierIds.length === 0) return;

    const accessibleVerifierIds = await this.filterAccessibleRecipients(
      verifierIds,
      pageId,
      spaceId,
    );
    if (accessibleVerifierIds.length === 0) return;

    for (const userId of accessibleVerifierIds) {
      await this.notificationService.create({
        userId,
        workspaceId,
        type: NotificationType.PAGE_APPROVAL_REQUESTED,
        actorId,
        pageId,
        spaceId,
      });
    }
  }

  async processApprovalRejected(
    data: IApprovalRejectedNotificationJob,
  ) {
    const { pageId, spaceId, workspaceId, actorId, requestedById } = data;

    const recipients = await this.filterAccessibleRecipients(
      [requestedById],
      pageId,
      spaceId,
    );
    if (recipients.length === 0) return;

    await this.notificationService.create({
      userId: requestedById,
      workspaceId,
      type: NotificationType.PAGE_APPROVAL_REJECTED,
      actorId,
      pageId,
      spaceId,
    });
  }
}