import {
  Alert,
  Button,
  Modal,
  Select,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { zodResolver } from "mantine-form-zod-resolver";
import { useForm } from "@mantine/form";
import { useTranslation } from "react-i18next";
import { useEffect, useState } from "react";
import { z } from "zod/v4";
import { useCreateWorkspaceMemberMutation } from "@/features/workspace/queries/workspace-query.ts";
import { UserRole } from "@/lib/types.ts";

interface Props {
  opened: boolean;
  onClose: () => void;
}

const formSchema = z.object({
  name: z.string().min(1).max(50).optional(),
  email: z.string().email(),
  role: z.enum(["admin", "member"]),
});
type FormValues = z.infer<typeof formSchema>;

export default function CreateMemberModal({ opened, onClose }: Props) {
  const { t } = useTranslation();
  const createMemberMutation = useCreateWorkspaceMemberMutation();
  const [generatedPassword, setGeneratedPassword] = useState<string | null>(
    null,
  );

  const form = useForm<FormValues>({
    validate: zodResolver(formSchema),
    initialValues: {
      name: "",
      email: "",
      role: "member",
    },
  });

  useEffect(() => {
    if (opened) {
      form.reset();
      setGeneratedPassword(null);
    }
  }, [opened]);

  const handleSubmit = async (values: FormValues) => {
    const result = await createMemberMutation.mutateAsync(values);
    setGeneratedPassword(result.password);
    notifications.show({
      message: t("Member created successfully"),
    });
  };

  const handleClose = () => {
    form.reset();
    setGeneratedPassword(null);
    onClose();
  };

  return (
    <Modal
      opened={opened}
      onClose={handleClose}
      title={t("Create member")}
      centered
    >
      <Stack>
        <Text size="sm" c="dimmed">
          {t(
            "An account will be created with a randomly generated password. Share the password with the user so they can sign in and change it.",
          )}
        </Text>

        <form onSubmit={form.onSubmit(handleSubmit)}>
          <TextInput
            label={t("Name")}
            placeholder={t("enter full name")}
            variant="filled"
            data-autofocus
            {...form.getInputProps("name")}
          />
          <TextInput
            label={t("Email")}
            placeholder="name@example.com"
            variant="filled"
            mt="sm"
            autoComplete="off"
            data-1p-ignore
            data-lpignore="true"
            data-bwignore
            description={t(
              "The email is used as the sign-in name. Any working email is fine.",
            )}
            {...form.getInputProps("email")}
          />
          <Select
            label={t("Role")}
            variant="filled"
            mt="sm"
            data={[
              { value: UserRole.MEMBER, label: t("Member") },
              { value: UserRole.ADMIN, label: t("Admin") },
            ]}
            allowDeselect={false}
            checkIconPosition="right"
            {...form.getInputProps("role")}
          />
          <Button
            type="submit"
            fullWidth
            mt="md"
            loading={createMemberMutation.isPending}
          >
            {t("Create member")}
          </Button>
        </form>

        {generatedPassword && (
          <Alert color="yellow" title={t("One-time password")}>
            <Text size="sm">
              {t(
                "Share this password with the user. It will not be shown again.",
              )}
            </Text>
            <Text size="sm" fw={700} ta="center" my="sm">
              {generatedPassword}
            </Text>
          </Alert>
        )}
      </Stack>
    </Modal>
  );
}