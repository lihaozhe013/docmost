import { useState } from "react";
import { login, logout, setupWorkspace } from "@/features/auth/services/auth-service";
import { useNavigate } from "react-router-dom";
import { useAtom } from "jotai";
import { currentUserAtom } from "@/features/user/atoms/current-user-atom";
import { ILogin, ISetupWorkspace } from "@/features/auth/types/auth.types";
import { notifications } from "@mantine/notifications";
import APP_ROUTE, { getPostLoginRedirect } from "@/lib/app-route.ts";
import { RESET } from "jotai/utils";
import { useTranslation } from "react-i18next";

export default function useAuth() {
  const { t } = useTranslation();
  const [isLoading, setIsLoading] = useState(false);
  const navigate = useNavigate();
  const [, setCurrentUser] = useAtom(currentUserAtom);

  const handleSignIn = async (data: ILogin) => {
    setIsLoading(true);

    try {
      const response = await login(data);
      setIsLoading(false);

      // Check if MFA is required
      if (response?.userHasMfa) {
        navigate(APP_ROUTE.AUTH.MFA_CHALLENGE + window.location.search);
      } else if (response?.requiresMfaSetup) {
        navigate(APP_ROUTE.AUTH.MFA_SETUP_REQUIRED + window.location.search);
      } else {
        navigate(getPostLoginRedirect());
      }
    } catch (err) {
      setIsLoading(false);

      const message = err.response?.data?.message;

      notifications.show({
        message,
        color: "red",
      });
    }
  };

  const handleSetupWorkspace = async (data: ISetupWorkspace) => {
    setIsLoading(true);

    try {
      const res = await setupWorkspace(data);
      setIsLoading(false);
      navigate(APP_ROUTE.HOME);
    } catch (err) {
      setIsLoading(false);
      notifications.show({
        message: err.response?.data.message,
        color: "red",
      });
    }
  };

  const handleLogout = async () => {
    setCurrentUser(RESET);
    await logout();
    window.location.replace(`${APP_ROUTE.AUTH.LOGIN}?logout=1`);
  };

  return {
    signIn: handleSignIn,
    setupWorkspace: handleSetupWorkspace,
    logout: handleLogout,
    isLoading,
  };
}