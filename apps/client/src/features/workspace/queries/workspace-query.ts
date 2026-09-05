import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  UseQueryResult,
} from "@tanstack/react-query";
import {
  changeMemberRole,
  getWorkspaceMembers,
  getWorkspace,
  getWorkspacePublicData,
  getAppVersion,
  deleteWorkspaceMember,
  deactivateWorkspaceMember,
  activateWorkspaceMember,
  createWorkspaceMember,
  resetWorkspaceMemberPassword,
} from "@/features/workspace/services/workspace-service";
import { IPagination, QueryParams } from "@/lib/types.ts";
import { notifications } from "@mantine/notifications";
import {
  ICreateWorkspaceUser,
  IPublicWorkspace,
  IVersion,
  IWorkspace,
} from "@/features/workspace/types/workspace.types.ts";
import { IUser } from "@/features/user/types/user.types.ts";
import { useTranslation } from "react-i18next";

export function useWorkspaceQuery(): UseQueryResult<IWorkspace, Error> {
  return useQuery({
    queryKey: ["workspace"],
    queryFn: () => getWorkspace(),
  });
}

export function useWorkspacePublicDataQuery(): UseQueryResult<
  IPublicWorkspace,
  Error
> {
  return useQuery({
    queryKey: ["workspace-public"],
    queryFn: () => getWorkspacePublicData(),
  });
}

export function useWorkspaceMembersQuery(
  params?: QueryParams,
): UseQueryResult<IPagination<IUser>, Error> {
  return useQuery({
    queryKey: ["workspaceMembers", params],
    queryFn: () => getWorkspaceMembers(params),
    placeholderData: keepPreviousData,
  });
}

export function useDeleteWorkspaceMemberMutation() {
  const queryClient = useQueryClient();

  return useMutation<
    void,
    Error,
    {
      userId: string;
    }
  >({
    mutationFn: (data) => deleteWorkspaceMember(data),
    onSuccess: (data, variables) => {
      notifications.show({ message: "Member deleted successfully" });
      queryClient.invalidateQueries({
        queryKey: ["workspaceMembers"],
      });
    },
    onError: (error) => {
      const errorMessage = error["response"]?.data?.message;
      notifications.show({ message: errorMessage, color: "red" });
    },
  });
}

export function useDeactivateWorkspaceMemberMutation() {
  const queryClient = useQueryClient();

  return useMutation<
    void,
    Error,
    {
      userId: string;
    }
  >({
    mutationFn: (data) => deactivateWorkspaceMember(data),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["workspaceMembers"],
      });
    },
    onError: (error) => {
      const errorMessage = error["response"]?.data?.message;
      notifications.show({ message: errorMessage, color: "red" });
    },
  });
}

export function useActivateWorkspaceMemberMutation() {
  const queryClient = useQueryClient();

  return useMutation<
    void,
    Error,
    {
      userId: string;
    }
  >({
    mutationFn: (data) => activateWorkspaceMember(data),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["workspaceMembers"],
      });
    },
    onError: (error) => {
      const errorMessage = error["response"]?.data?.message;
      notifications.show({ message: errorMessage, color: "red" });
    },
  });
}

export function useChangeMemberRoleMutation() {
  const queryClient = useQueryClient();

  return useMutation<any, Error, any>({
    mutationFn: (data) => changeMemberRole(data),
    onSuccess: (data, variables) => {
      notifications.show({ message: "Member role updated successfully" });
      queryClient.refetchQueries({
        queryKey: ["workspaceMembers"],
      });
    },
    onError: (error) => {
      const errorMessage = error["response"]?.data?.message;
      notifications.show({ message: errorMessage, color: "red" });
    },
  });
}

export function useCreateWorkspaceMemberMutation() {
  const queryClient = useQueryClient();

  return useMutation<
    { user: IUser; password: string },
    Error,
    ICreateWorkspaceUser
  >({
    mutationFn: (data) => createWorkspaceMember(data),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["workspaceMembers"],
      });
    },
    onError: (error) => {
      const errorMessage = error["response"]?.data?.message;
      notifications.show({ message: errorMessage, color: "red" });
    },
  });
}

export function useResetWorkspaceMemberPasswordMutation() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  return useMutation<
    { user: { id: string; name: string; email: string }; password: string },
    Error,
    { userId: string }
  >({
    mutationFn: (data) => resetWorkspaceMemberPassword(data),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["workspaceMembers"],
      });
    },
    onError: (error) => {
      const errorMessage = error["response"]?.data?.message;
      notifications.show({ message: errorMessage, color: "red" });
    },
  });
}

export function useAppVersion(
  isEnabled: boolean,
): UseQueryResult<IVersion, Error> {
  return useQuery({
    queryKey: ["version"],
    queryFn: () => getAppVersion(),
    staleTime: 60 * 60 * 1000, // 1 hr
    enabled: isEnabled,
    refetchOnMount: true,
  });
}
