import React, { Suspense } from "react";

export default function LoadingBoundary({ placeholder = null, children }) {
  return <Suspense fallback={placeholder}>{children}</Suspense>;
}
