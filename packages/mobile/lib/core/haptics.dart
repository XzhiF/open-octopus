import 'package:flutter/services.dart';

/// 触感反馈：只在「有后果」的动作上给一下 —— 不做全局点击音效。
///
/// - [tap]：连接 / 启动 / 发送这类普通按钮；
/// - [ok]：配对成功、机器被拉起来这类「成了」的时刻。
///
/// widget test 里平台通道是空的，这些调用是 no-op，不影响测试。
abstract final class Haptics {
  static void tap() {
    HapticFeedback.selectionClick();
  }

  static void ok() {
    HapticFeedback.mediumImpact();
  }
}
