import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../widgets/splash.dart';
import 'router.dart';
import 'theme.dart';

class OctopusMobileApp extends ConsumerWidget {
  const OctopusMobileApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final router = ref.watch(routerProvider);
    return MaterialApp.router(
      title: 'Octopus',
      debugShowCheckedModeBanner: false,
      theme: buildOctoTheme(),
      routerConfig: router,
      builder: (context, child) {
        return AnnotatedRegion<SystemUiOverlayStyle>(
          value: const SystemUiOverlayStyle(
            statusBarColor: Colors.transparent,
            statusBarIconBrightness: Brightness.light,
            statusBarBrightness: Brightness.dark,
            systemNavigationBarColor: Color(0xFF07050F),
            systemNavigationBarIconBrightness: Brightness.light,
          ),
          child: SplashGate(child: child ?? const SizedBox.shrink()),
        );
      },
    );
  }
}
