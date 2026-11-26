import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../features/cabins/cabin_list_screen.dart';
import '../features/cabins/cabin_screen.dart';
import '../features/chat/global_chat_screen.dart';
import '../features/chat/session_screen.dart';
import '../features/devices/add_device_screen.dart';
import '../features/devices/devices_screen.dart';
import '../features/settings/settings_screen.dart';
import '../features/tasks/task_detail_screen.dart';

final routerProvider = Provider<GoRouter>((ref) {
  final router = GoRouter(
    initialLocation: '/',
    routes: [
      GoRoute(path: '/', builder: (context, state) => const DevicesScreen()),
      GoRoute(path: '/add-device', builder: (context, state) => const AddDeviceScreen()),
      GoRoute(path: '/device', builder: (context, state) => const CabinListScreen()),
      GoRoute(
        path: '/cabin/:cabinId',
        builder: (context, state) =>
            CabinScreen(cabinId: state.pathParameters['cabinId'] ?? ''),
      ),
      GoRoute(
        path: '/cabin/:cabinId/task/:taskId',
        builder: (context, state) =>
            TaskDetailScreen(taskId: state.pathParameters['taskId'] ?? ''),
      ),
      GoRoute(
        path: '/session/:workspaceId/:sessionId',
        builder: (context, state) => SessionScreen(
          workspaceId: state.pathParameters['workspaceId'],
          sessionId: state.pathParameters['sessionId'] ?? '',
        ),
      ),
      GoRoute(path: '/chat', builder: (context, state) => const GlobalChatScreen()),
      GoRoute(
        path: '/global/:sessionId',
        builder: (context, state) =>
            SessionScreen(workspaceId: null, sessionId: state.pathParameters['sessionId'] ?? ''),
      ),
      GoRoute(path: '/settings', builder: (context, state) => const SettingsScreen()),
    ],
  );
  ref.onDispose(router.dispose);
  return router;
});
