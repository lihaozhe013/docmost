import api from "@/lib/api-client";
import { IUser } from "@/features/user/types/user.types";
import {
  ICreateWorkspaceUser,
  IWorkspace,
  IPublicWorkspace,
  IResetUserPasswordResult,
  IVersion,
} from "../types/workspace.types";
import { IPagination, QueryParams } from "@/lib/types.ts";

export async function getWorkspace(): Promise<IWorkspace> {
  const req = await api.post<IWorkspace>("/workspace/info");
  return req.data;
}

export async function getWorkspacePublicData(): Promise<IPublicWorkspace> {
  const req = await api.post<IPublicWorkspace>("/workspace/public");
  return req.data;
}

export async function getCheckHostname(
  hostname: string,
): Promise<{ hostname: string }> {
  const req = await api.post("/workspace/check-hostname", { hostname });
  return req.data;
}

export async function getWorkspaceMembers(
  params?: QueryParams,
): Promise<IPagination<IUser>> {
  const req = await api.post("/workspace/members", params);
  return req.data;
}

export async function deleteWorkspaceMember(data: {
  userId: string;
}): Promise<void> {
  await api.post("/workspace/members/delete", data);
}

export async function deactivateWorkspaceMember(data: {
  userId: string;
}): Promise<void> {
  await api.post("/workspace/members/deactivate", data);
}

export async function activateWorkspaceMember(data: {
  userId: string;
}): Promise<void> {
  await api.post("/workspace/members/activate", data);
}

export async function updateWorkspace(data: Partial<IWorkspace>) {
  const req = await api.post<IWorkspace>("/workspace/update", data);
  return req.data;
}

export async function changeMemberRole(data: {
  userId: string;
  role: string;
}): Promise<void> {
  await api.post("/workspace/members/change-role", data);
}

export async function createWorkspaceMember(
  data: ICreateWorkspaceUser,
): Promise<{ user: IUser; password: string }> {
  const req = await api.post("/workspace/members/create", data);
  return req.data;
}

export async function resetWorkspaceMemberPassword(
  data: { userId: string },
): Promise<IResetUserPasswordResult> {
  const req = await api.post("/workspace/members/reset-password", data);
  return req.data;
}

export async function getAppVersion(): Promise<IVersion> {
  const req = await api.post("/version");
  return req.data;
}
