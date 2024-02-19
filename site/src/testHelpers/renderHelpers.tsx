import {
  render as testingLibraryRender,
  screen,
  waitFor,
  renderHook,
  RenderHookOptions,
  RenderHookResult,
} from "@testing-library/react";
import { type ReactNode, useState, FC, PropsWithChildren } from "react";
import { QueryClient } from "react-query";
import { AppProviders } from "App";
import { RequireAuth } from "contexts/auth/RequireAuth";
import { ThemeProvider } from "contexts/ThemeProvider";
import { DashboardLayout } from "modules/dashboard/DashboardLayout";
import { TemplateSettingsLayout } from "pages/TemplateSettingsPage/TemplateSettingsLayout";
import { WorkspaceSettingsLayout } from "pages/WorkspaceSettingsPage/WorkspaceSettingsLayout";
import {
  createMemoryRouter,
  RouterProvider,
  type RouteObject,
  MemoryRouter,
  Routes,
  Route,
  useLocation,
} from "react-router-dom";
import { MockUser } from "./entities";

function createTestQueryClient() {
  // Helps create one query client for each test case, to make sure that tests
  // are isolated and can't affect each other
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        cacheTime: 0,
        refetchOnWindowFocus: false,
        networkMode: "offlineFirst",
      },
    },
  });
}

export const renderWithRouter = (
  router: ReturnType<typeof createMemoryRouter>,
) => {
  const queryClient = createTestQueryClient();

  return {
    ...testingLibraryRender(
      <AppProviders queryClient={queryClient}>
        <RouterProvider router={router} />
      </AppProviders>,
    ),
    router,
  };
};

export const render = (element: ReactNode) => {
  return renderWithRouter(
    createMemoryRouter(
      [
        {
          path: "/",
          element,
        },
      ],
      { initialEntries: ["/"] },
    ),
  );
};

export type RenderWithAuthOptions = {
  // The current URL, /workspaces/123
  route?: string;
  // The route path, /workspaces/:workspaceId
  path?: string;
  // Extra routes to add to the router. It is helpful when having redirecting
  // routes or multiple routes during the test flow
  extraRoutes?: RouteObject[];
  // The same as extraRoutes but for routes that don't require authentication
  nonAuthenticatedRoutes?: RouteObject[];
  // In case you want to render a layout inside of it
  children?: RouteObject["children"];
};

export function renderWithAuth(
  element: JSX.Element,
  {
    path = "/",
    route = "/",
    extraRoutes = [],
    nonAuthenticatedRoutes = [],
    children,
  }: RenderWithAuthOptions = {},
) {
  const routes: RouteObject[] = [
    {
      element: <RequireAuth />,
      children: [{ path, element, children }, ...extraRoutes],
    },
    ...nonAuthenticatedRoutes,
  ];

  const renderResult = renderWithRouter(
    createMemoryRouter(routes, { initialEntries: [route] }),
  );

  return {
    user: MockUser,
    ...renderResult,
  };
}

type RenderHookWithAuthOptions<Props> = Partial<
  Readonly<
    Omit<RenderWithAuthOptions, "children"> & {
      initialProps: Props;
    }
  >
>;

export type RenderHookWithAuthConfig<Props> = Readonly<{
  routingOptions?: Omit<RenderWithAuthOptions, "children">;
  renderOptions?: Omit<RenderHookOptions<Props>, "wrapper">;
}>;

export type RenderHookWithAuthResult<Result, Props> = Promise<
  Readonly<
    RenderHookResult<Result, Props> & {
      queryClient: QueryClient;

      /**
       * Gives you access to the URLSearchParams associated with the test's
       * isolated router. Treat this value as a snapshot; as in, there is a
       * chance that will stop being accurate after the next re-render
       */
      getSearchParamsSnapshot: () => URLSearchParams;
    }
  >
>;

/**
 * Gives you a custom version of renderHook that is aware of all our App
 * providers (query, routing, etc.).
 *
 * Unfortunately, React Router does not make it easy to access the router after
 * it's been set up, which can lead to some chicken-or-the-egg situations
 * @see {@link https://github.com/coder/coder/pull/10362#discussion_r1380852725}
 *
 * Initially tried setting up the router with a useState hook in the renderHook
 * wrapper, but even though it was valid for the mounting render, the code was
 * fragile. You could only safely test re-renders via your hook's exposed
 * methods; calling renderHook's rerender method directly caused the router to
 * get lost/disconnected.
 */
export async function renderHookWithAuth2<Result, Props>(
  render: (initialProps: Props) => Result,
  config: RenderHookWithAuthConfig<Props>,
): RenderHookWithAuthResult<Result, Props> {
  const { routingOptions = {}, renderOptions = {} } = config;
  const {
    path = "/",
    route = "/",
    extraRoutes = [],
    nonAuthenticatedRoutes = [],
  } = routingOptions;

  const ArbitraryRoute: FC<{ route: RouteObject }> = ({ route }) => (
    <Route path={route.path} element={route.element} />
  );

  /**
   * Have to do some incredibly, incredibly cursed things here. Scoured the
   * tests for the React Router source code, and from their examples, there
   * didn't appear to be any examples of they do
   * not provide you a way to access the
   */
  // Easy to miss - evil definite assignment
  let escapedLocation!: ReturnType<typeof useLocation>;
  const LocationLeaker: FC<PropsWithChildren> = ({ children }) => {
    const location = useLocation();
    escapedLocation = location;
    return <>{children}</>;
  };

  /**
   * Can't use the fancy createMemoryRouter function, because it gives you no
   * direct way to re-render with arbitrary children. That's a deal-breaker when
   * trying to test custom hooks - it removes your ability to unit-test them
   */
  const MemoryRouterWrapper: FC<PropsWithChildren> = ({ children }) => {
    return (
      <MemoryRouter initialEntries={[route]}>
        <Routes>
          <Route element={<RequireAuth />}>
            <Route
              path={path}
              element={<LocationLeaker>{children}</LocationLeaker>}
            />

            {extraRoutes.map((route, index) => (
              <ArbitraryRoute key={route.path ?? index} route={route} />
            ))}
          </Route>

          {nonAuthenticatedRoutes.map((route, index) => (
            <ArbitraryRoute key={route.path ?? index} route={route} />
          ))}
        </Routes>
      </MemoryRouter>
    );
  };

  const queryClient = createTestQueryClient();

  const { result, rerender, unmount } = renderHook(render, {
    ...renderOptions,
    wrapper: ({ children }) => (
      <AppProviders queryClient={queryClient}>
        <MemoryRouterWrapper>{children}</MemoryRouterWrapper>
      </AppProviders>
    ),
  });

  /**
   * This is necessary to get around some providers in AppProviders having
   * conditional rendering and not always rendering their children immediately.
   *
   * renderHook's result won't actually exist until the children defined via its
   * wrapper render in full. Ignore result.current's type signature; it lies to
   * you, which is normally a good thing (no needless null checks), but not here
   */
  await waitFor(() => expect(result.current).not.toBe(null));

  if (escapedLocation === undefined) {
    throw new Error("Failed definite initialization for location during setup");
  }

  return {
    result,
    rerender,
    unmount,
    queryClient,
    getSearchParamsSnapshot: () => new URLSearchParams(escapedLocation.search),
  } as const;
}

/**
 * Custom version of renderHook that is aware of all our App providers.
 *
 * Had to do some nasty, cursed things in the implementation to make sure that
 * the tests using this function remained simple.
 *
 * @see {@link https://github.com/coder/coder/pull/10362#discussion_r1380852725}
 */
export async function renderHookWithAuth<Result, Props>(
  render: (initialProps: Props) => Result,
  options: RenderHookWithAuthOptions<Props> = {},
) {
  const { initialProps, path = "/", route = "/", extraRoutes = [] } = options;
  const queryClient = createTestQueryClient();

  // Easy to miss – there's an evil definite assignment via the !
  let escapedRouter!: ReturnType<typeof createMemoryRouter>;

  const { result, rerender, unmount } = renderHook(render, {
    initialProps,
    wrapper: ({ children }) => {
      /**
       * Unfortunately, there isn't a way to define the router outside the
       * wrapper while keeping it aware of children, meaning that we need to
       * define the router as readonly state in the component instance. This
       * ensures the value remains stable across all re-renders
       */
      // eslint-disable-next-line react-hooks/rules-of-hooks -- This is actually processed as a component; the linter just isn't aware of that
      const [readonlyStatefulRouter] = useState(() => {
        return createMemoryRouter(
          [{ path, element: <>{children}</> }, ...extraRoutes],
          { initialEntries: [route] },
        );
      });

      /**
       * Leaks the wrapper component's state outside React's render cycles.
       */
      escapedRouter = readonlyStatefulRouter;

      return (
        <AppProviders queryClient={queryClient}>
          <RouterProvider router={readonlyStatefulRouter} />
        </AppProviders>
      );
    },
  });

  /**
   * This is necessary to get around some providers in AppProviders having
   * conditional rendering and not always rendering their children immediately.
   *
   * The hook result won't actually exist until the children defined via wrapper
   * render in full.
   */
  await waitFor(() => expect(result.current).not.toBe(null));

  return {
    result,
    rerender,
    unmount,
    router: escapedRouter,
  } as const;
}

export function renderWithTemplateSettingsLayout(
  element: JSX.Element,
  {
    path = "/",
    route = "/",
    extraRoutes = [],
    nonAuthenticatedRoutes = [],
  }: RenderWithAuthOptions = {},
) {
  const routes: RouteObject[] = [
    {
      element: <RequireAuth />,
      children: [
        {
          element: <DashboardLayout />,
          children: [
            {
              element: <TemplateSettingsLayout />,
              children: [{ path, element }, ...extraRoutes],
            },
          ],
        },
      ],
    },
    ...nonAuthenticatedRoutes,
  ];

  const renderResult = renderWithRouter(
    createMemoryRouter(routes, { initialEntries: [route] }),
  );

  return {
    user: MockUser,
    ...renderResult,
  };
}

export function renderWithWorkspaceSettingsLayout(
  element: JSX.Element,
  {
    path = "/",
    route = "/",
    extraRoutes = [],
    nonAuthenticatedRoutes = [],
  }: RenderWithAuthOptions = {},
) {
  const routes: RouteObject[] = [
    {
      element: <RequireAuth />,
      children: [
        {
          element: <DashboardLayout />,
          children: [
            {
              element: <WorkspaceSettingsLayout />,
              children: [{ element, path }, ...extraRoutes],
            },
          ],
        },
      ],
    },
    ...nonAuthenticatedRoutes,
  ];

  const renderResult = renderWithRouter(
    createMemoryRouter(routes, { initialEntries: [route] }),
  );

  return {
    user: MockUser,
    ...renderResult,
  };
}

export const waitForLoaderToBeRemoved = async (): Promise<void> => {
  return waitFor(
    () => {
      expect(screen.queryByTestId("loader")).not.toBeInTheDocument();
    },
    {
      timeout: 5_000,
    },
  );
};

export const renderComponent = (component: React.ReactElement) => {
  return testingLibraryRender(component, {
    wrapper: ({ children }) => <ThemeProvider>{children}</ThemeProvider>,
  });
};
