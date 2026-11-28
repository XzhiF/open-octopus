import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../core/haptics.dart';

/// 设备列表（栈底）的返回兜底：系统返回键 / 手势导航的边缘左滑不再一把退出 App。
///
/// 默认行为是停在栈底时直接退 App，手一滑就没了。这里改成两步：第一次只提示
/// 「再返回一次退出」，2 秒内再返回一次才真的退；超时就重新计时。
class BackToExit extends StatefulWidget {
  const BackToExit({super.key, required this.child});

  final Widget child;

  @override
  State<BackToExit> createState() => _BackToExitState();
}

class _BackToExitState extends State<BackToExit> {
  static const Duration _window = Duration(seconds: 2);

  /// 非空 = 刚按过一次，正等着第二次。
  Timer? _armed;

  @override
  void dispose() {
    _armed?.cancel();
    super.dispose();
  }

  void _onBack() {
    final armed = _armed;
    if (armed != null) {
      armed.cancel();
      _armed = null;
      SystemNavigator.pop();
      return;
    }
    _armed = Timer(_window, () => _armed = null);
    Haptics.tap();
    ScaffoldMessenger.maybeOf(context)
      ?..hideCurrentSnackBar()
      ..showSnackBar(
        const SnackBar(content: Text('再返回一次退出 Octopus'), duration: _window),
      );
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, result) {
        if (didPop) return;
        _onBack();
      },
      child: widget.child,
    );
  }
}
