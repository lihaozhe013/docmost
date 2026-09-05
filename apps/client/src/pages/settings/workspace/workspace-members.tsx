import { Button, Group, Space } from "@mantine/core";
import WorkspaceMembersTable from "@/features/workspace/components/members/components/workspace-members-table";
import CreateMemberModal from "@/features/workspace/components/members/components/create-member-modal.tsx";
import SettingsTitle from "@/components/settings/settings-title.tsx";
import { useState } from "react";
import useUserRole from "@/hooks/use-user-role.tsx";
import { useTranslation } from "react-i18next";
import { useAtom } from "jotai";
import { workspaceAtom } from "@/features/user/atoms/current-user-atom.ts";
import { DocumentTitle } from "@/components/ui/document-title.tsx";
import { IconUserPlus } from "@tabler/icons-react";

export default function WorkspaceMembers() {
  const { t } = useTranslation();
  const [createModalOpened, setCreateModalOpened] = useState(false);
  const [workspace] = useAtom(workspaceAtom);
  const { isAdmin } = useUserRole();

  return (
    <>
      <DocumentTitle title={t("Members")} />
      <SettingsTitle title={t("Members")} />

      <Group justify="flex-end">
        <Button
          leftSection={<IconUserPlus size={16} />}
          disabled={!isAdmin}
          onClick={() => setCreateModalOpened(true)}
        >
          {t("Create member")}
        </Button>
      </Group>

      <Space h="lg" />

      <WorkspaceMembersTable />

      <CreateMemberModal
        opened={createModalOpened}
        onClose={() => setCreateModalOpened(false)}
      />
    </>
  );
}