/**
 * @deprecated Import from repository/errors.ts instead.
 * This file re-exports for backward compatibility.
 */
export {
  RepoError,
  ResourceNotFoundError,
  CircularDependencyError,
  DepthExceededError,
  SourceFetchError,
  ManifestParseError,
  LockConflictError,
  ReverseDependencyError,
  SecurityError,
  InstallVerificationError,
} from "../repository/errors"
export type { RepoErrorCode } from "../repository/errors"
