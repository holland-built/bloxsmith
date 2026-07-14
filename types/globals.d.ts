/* Ambient declarations for the concat-build app globals that
   src/15.mutations.jsx references from OTHER src/*.jsx fragments.
   The app has no imports — every fragment shares one implicit global
   scope — so scoped `// @ts-check` on 15.mutations.jsx needs these
   declared here. Browser globals (document/window/CustomEvent/Event/
   HTMLInputElement) come from the DOM lib enabled in tsconfig, NOT here.

   Loose/`any` on purpose: the real definitions live in sibling fragments
   and are not type-checked in this scoped pass. */

declare const LS: {
  get(key: string, fallback?: any): any;
  set(key: string, val: any): void;
  del(key: string): void;
};

declare function toast(msg: string, kind?: string, opts?: any): void;

declare function useAuth(): any;

declare const React: any;
declare const ReactDOM: any;

declare function useState<T = any>(init?: T | (() => T)): [any, (v: any) => void];
declare function useEffect(fn: () => any, deps?: any[]): void;
declare function useRef<T = any>(init?: T): { current: any };
declare function useCallback<T = any>(fn: T, deps?: any[]): T;
declare function useMemo<T = any>(fn: () => T, deps?: any[]): T;

/* The app has no React type packages installed. `jsx: "react-jsx"` still
   resolves JSX against the global JSX namespace and imports the runtime
   from 'react/jsx-runtime' — declare both loosely so scoped checking of the
   JSX in 15.mutations.jsx passes without wiring real React types. Making
   every intrinsic element's props `any` also contextually types inline JSX
   event handlers as `any`, so they are not flagged under noImplicitAny. */
declare namespace JSX {
  interface IntrinsicElements {
    [name: string]: any;
  }
  type Element = any;
  interface ElementClass {}
  interface ElementAttributesProperty {}
  interface ElementChildrenAttribute {}
}

declare module 'react/jsx-runtime' {
  export const jsx: any;
  export const jsxs: any;
  export const Fragment: any;
}
