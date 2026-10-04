import type { ClientCommand } from "@forge/protocol";

/** Inventory is not a conversation authority. Only these existing, explicitly
 * addressed project/session operations may use origin-level manager authority.
 * Conversation/choice/goal/browser/terminal/file/feedback defaults stay denied.
 */
export function isInventoryCommandAllowed(command: ClientCommand): boolean {
  switch (command.type) {
    case "subscribe":
    case "subscribe_inventory":
    case "dismiss_session_attention":
    case "mark_unread":
    case "mark_all_read":
    case "create_manager":
    case "delete_manager":
    case "create_session":
    case "rename_profile":
    case "archive_profile":
    case "restore_profile":
    case "hydrate_archive_last_used":
    case "rename_session":
    case "pin_session":
    case "archive_session":
    case "restore_session":
    case "delete_session":
    case "stop_session":
    case "resume_session":
    case "fork_session":
    case "update_manager_model":
    case "update_manager_cwd":
    case "validate_directory":
    case "list_directories":
      return true;
    case "api_proxy": {
      // Exact paths only; never a generic proxy or a subscription-derived target.
      if (command.method === "GET") return command.path === "/api/settings/manager-selection-catalog";
      return command.method === "POST" && (
        command.path === "/api/mobile/push/register"
        || command.path === "/api/mobile/push/unregister"
        || command.path === "/api/mobile/devices/register"
      );
    }
    default:
      return false;
  }
}
