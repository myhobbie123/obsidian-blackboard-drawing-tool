/** Host-provided CM6 module, already externalised by the release bundler. */
declare module '@codemirror/commands' {
  export const isolateHistory: { of(value: 'before' | 'after' | 'full'): unknown };
}
