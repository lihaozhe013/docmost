import { Alert, Menu, ActionIcon, Text, Button, Group } from "@mantine/core";
import React, { useState } from "react";
import {
  IconDots,
  IconTrash,
  IconUserOff,
  IconUserCheck,
  IconKey,
} from "@tabler/icons-react";
import { modals } from "@mantine/modals";
import {
  useDeleteWorkspaceMemberMutation,
  useDeactivateWorkspaceMemberMutation,
  useActivateWorkspaceMemberMutation,
  useResetWorkspaceMemberPasswordMutation,
} from "@/features/workspace/queries/workspace-query.ts";
import { useTranslation } from "react-i18next";
import useUserRole from "@/hooks/use-user-role.tsx";

interface Props {
  userId: string;
  name: string;
  deactivatedAt: Date | null;
}
export default function MemberActionMenu({
  userId,
  name,
  deactivatedAt,
}: Props) {
  const { t } = useTranslation();
  const deleteWorkspaceMemberMutation = useDeleteWorkspaceMemberMutation();
  const deactivateMutation = useDeactivateWorkspaceMemberMutation();
  const activateMutation = useActivateWorkspaceMemberMutation();
  const resetPasswordMutation = useResetWorkspaceMemberPasswordMutation();
  const { isAdmin } = useUserRole();
  const [resetPassword, setResetPassword] = useState<string | null>(null);

  const isDeactivated = !!deactivatedAt;

  const onDeactivate = async () => {
    await deactivateMutation.mutateAsync({ userId });
  };

  const onActivate = async () => {
    await activateMutation.mutateAsync({ userId });
  };

  const openDeactivateModal = () =>
    modals.openConfirmModal({
      title: isDeactivated ? t("Activate member") : t("Deactivate member"),
      children: (
        <Text size="sm">
          {isDeactivated
            ? t("Are you sure you want to activate this workspace member?")
            : t(
                "Are you sure you want to deactivate this workspace member? They will no longer be able to access this workspace.",
              )}
        </Text>
      ),
      centered: true,
      labels: {
        confirm: isDeactivated ? t("Activate") : t("Deactivate"),
        cancel: t("Cancel"),
      },
      confirmProps: { color: isDeactivated ? "blue" : "orange" },
      onConfirm: isDeactivated ? onActivate : onDeactivate,
    });

  const onRevoke = async () => {
    await deleteWorkspaceMemberMutation.mutateAsync({ userId });
  };

  const openRevokeModal = () =>
    modals.openConfirmModal({
      title: t("Delete member"),
      children: (
        <Text size="sm">
          {t(
            "Are you sure you want to delete this workspace member? This action is irreversible.",
          )}
        </Text>
      ),
      centered: true,
      labels: { confirm: t("Delete"), cancel: t("Don't") },
      confirmProps: { color: "red" },
      onConfirm: onRevoke,
    });

  const openResetPasswordModal = () =>
    modals.openConfirmModal({
      title: t("Reset password"),
      children: (
        <Text size="sm">
          {t(
            "A new random password will be generated and shared only with you. The member will be signed out of all sessions.",
          )}
        </Text>
      ),
      centered: true,
      labels: { confirm: t("Reset password"), cancel: t("Cancel") },
      confirmProps: { color: "orange" },
      onConfirm: async () => {
        const result = await resetPasswordMutation.mutateAsync({ userId });
        setResetPassword(result.password);
      },
    });

  const closePasswordAlert = () => setResetPassword(null);

  return (
    <>
      {resetPassword && (
        <Alert
          color="yellow"
          title={`${t("One-time password for")} ${name}`}
          withCloseButton
          onClose={closePasswordAlert}
          m="sm"
        >
          <Text size="sm">
            {t(
              "Share this password with the member. It will not be shown again.",
            )}
          </Text>
          <Text size="sm" fw={700} ta="center" my="sm">
            {resetPassword}
          </Text>
          <Group justify="flex-end">
            <Button size="xs" variant="light" onClick={closePasswordAlert}>
              {t("Close")}
            </Button>
          </Group>
        </Alert>
      )}

      <Menu
        shadow="xl"
        position="bottom-end"
        offset={20}
        width={200}
        withArrow
        arrowPosition="center"
      >
        <Menu.Target>
          <ActionIcon
            variant="subtle"
            c="gray"
            aria-label={t("Member actions for {{name}}", { name })}
          >
            <IconDots size={20} stroke={2} />
          </ActionIcon>
        </Menu.Target>

        <Menu.Dropdown>
          {!isDeactivated && (
            <Menu.Item
              onClick={openResetPasswordModal}
              leftSection={<IconKey size={16} />}
              disabled={!isAdmin}
            >
              {t("Reset password")}
            </Menu.Item>
          )}

          <Menu.Item
            onClick={openDeactivateModal}
            leftSection={
              isDeactivated ? (
                <IconUserCheck size={16} />
              ) : (
                <IconUserOff size={16} />
              )
            }
            disabled={!isAdmin}
          >
            {isDeactivated ? t("Activate member") : t("Deactivate member")}
          </Menu.Item>

          <Menu.Divider />

          <Menu.Item
            c="red"
            onClick={openRevokeModal}
            leftSection={<IconTrash size={16} />}
            disabled={!isAdmin}
          >
            {t("Delete member")}
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
    </>
  );
}