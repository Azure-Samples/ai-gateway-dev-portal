import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';

interface TokenAuthState {
  token: string | null;
  isAuthenticated: boolean;
  signIn: (token: string) => void;
  signOut: () => void;
}

const TokenAuthContext = createContext<TokenAuthState>({
  token: null,
  isAuthenticated: false,
  signIn: () => {},
  signOut: () => {},
});

const STORAGE_KEY = 'azure_access_token';

export function TokenAuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() => sessionStorage.getItem(STORAGE_KEY));

  const signIn = useCallback((t: string) => {
    sessionStorage.setItem(STORAGE_KEY, t);
    setToken(t);
  }, []);

  const signOut = useCallback(() => {
    sessionStorage.removeItem(STORAGE_KEY);
    setToken(null);
  }, []);

  return (
    <TokenAuthContext.Provider value={{ token, isAuthenticated: !!token, signIn, signOut }}>
      {children}
    </TokenAuthContext.Provider>
  );
}

export function useTokenAuth() {
  return useContext(TokenAuthContext);
}
