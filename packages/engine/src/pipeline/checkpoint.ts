/**
 * Legacy re-export — CheckpointStore is now FilesystemCheckpointStore.
 * The SQLite implementation has been removed.
 */
export { FilesystemCheckpointStore as CheckpointStore, FilesystemCheckpointStore as SqliteCheckpointStore } from "./filesystem-checkpoint"
export type { CheckpointNodeResult, Checkpoint, CheckpointStoreConfig } from "./checkpoint-types"
