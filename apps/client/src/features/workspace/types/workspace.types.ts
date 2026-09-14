export interface IAuthProvider {
  id: string;
  name: string;
  type: string;
}

export interface IPublicWorkspace {
  id: string;
  name: string;
  logo: string;
  hostname: string;
  enforceSso: boolean;
  authProviders: IAuthProvider[];
}

export interface IWorkspace {
  id: string;
  name: string;
  description: string;
  logo: string;
  hostname: string;
  defaultSpaceId: string;
  customDomain: string;
  settings: IWorkspaceSettings;
  status: string;
  enforceSso: boolean;
  stripeCustomerId: string;
  billingEmail: string;
  trialEndAt: Date;
  createdAt: Date;
  updatedAt: Date;
  emailDomains: string[];
  memberCount?: number;
  plan?: string;
  enforceMfa?: boolean;
  disablePublicSharing?: boolean;
  trashRetentionDays?: number;
  restrictApiToAdmins?: boolean;
  allowMemberTemplates?: boolean;
  allowPersonalSpaces?: boolean;
  defaultPageEditMode?: string;
  isScimEnabled?: boolean;
}

export interface IWorkspaceSettings {
  sharing?: IWorkspaceSharingSettings;
  api?: IWorkspaceApiSettings;
  templates?: IWorkspaceTemplateSettings;
  spaces?: IWorkspaceSpaceSettings;
  defaultPageEditMode?: string;
}

export interface IWorkspaceApiSettings {
  restrictToAdmins?: boolean;
}

export interface IWorkspaceSharingSettings {
  disabled?: boolean;
}

export interface IWorkspaceTemplateSettings {
  allowMemberTemplates?: boolean;
}

export interface IWorkspaceSpaceSettings {
  allowPersonal?: boolean;
}

export interface ICreateWorkspaceUser {
  name?: string;
  email: string;
  role: 'admin' | 'member';
}

export interface IResetUserPasswordResult {
  user: { id: string; name: string; email: string };
  password: string;
}

export interface IPublicWorkspace {
  id: string;
  name: string;
  logo: string;
  hostname: string;
  enforceSso: boolean;
  authProviders: IAuthProvider[];
}

export interface IVersion {
  currentVersion: string;
  latestVersion: string;
  releaseUrl: string;
}
