// @quickpose/react-native@0.7.1 ships raw TypeScript source (its package.json
// `types` points at src/index) and deep-imports two React Native internal
// modules. Neither resolves under RN 0.87:
//   - react-native/Libraries/Utilities/codegenNativeComponent exists on disk,
//     but RN 0.87's package.json `exports` map blocks deep subpath imports.
//   - react-native/Libraries/Types/CodegenTypes no longer has a .d.ts at all;
//     it was renamed to CodegenTypesNamespace.
// Declaring them here keeps `tsc --noEmit` clean without patching node_modules
// or shadowing QuickPoseView's real prop types. Delete this file if the
// package ships prebuilt .d.ts files or updates its RN imports.

declare module 'react-native/Libraries/Utilities/codegenNativeComponent' {
  import type * as React from 'react';
  const codegenNativeComponent: <Props>(
    componentName: string,
  ) => React.ForwardRefExoticComponent<Props & React.RefAttributes<unknown>>;
  export default codegenNativeComponent;
}

declare module 'react-native/Libraries/Types/CodegenTypes' {
  export type Double = number;
  export type Float = number;
  export type Int32 = number;
  export type DirectEventHandler<T> = (event: { nativeEvent: T }) => void;
  export type BubblingEventHandler<T> = (event: { nativeEvent: T }) => void;
}
