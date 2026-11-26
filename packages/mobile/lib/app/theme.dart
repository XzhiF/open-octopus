import 'package:flutter/material.dart';

/// 全舱模式（docs/cabin-design/cockpit-v22.html）调色板的手机端移植。
/// 规则：颜色只在状态处用 —— 绿=运行中 / 琥珀=待你定 / 粉=待验收 / 青=可操作。
class Octo {
  const Octo._();

  // ── 强调色 ────────────────────────────────────────────────
  static const teal = Color(0xFF2EE6D6);
  static const tealLite = Color(0xFF69F2E4);
  static const tealDeep = Color(0xFF22D9C8);
  static const violet = Color(0xFF7B4DFF);
  static const sky = Color(0xFF35C7F0);
  static const pink = Color(0xFFFF6FB5);
  static const purple = Color(0xFFC9BFFF);
  static const gold = Color(0xFFF5C542);

  // ── 文字 ──────────────────────────────────────────────────
  static const ink = Color(0xFFEDEBFA);
  static const ink2 = Color(0xFFA9A3C8);
  static const dim = Color(0xFF8D86B8);
  static const metal = Color(0xFFB9B3D9);
  static const metal2 = Color(0xFF8D86B8);
  static const faint = Color(0xFF6F6A8F);

  // ── 底色 ──────────────────────────────────────────────────
  static const indigo = Color(0xFF0D0A1E);
  static const indigo2 = Color(0xFF1B1638);
  static const deep = Color(0xFF07050F);
  static const screen = Color(0xFF08060F);

  // ── 状态色 ────────────────────────────────────────────────
  static const green = Color(0xFF3DDC97);
  static const amber = Color(0xFFFFB020);
  static const red = Color(0xFFFF3B5C);
  static const off = Color(0xFF5B5678);

  // ── 线与玻璃 ──────────────────────────────────────────────
  /// rgba(46,230,214,.28)
  static const edge = Color(0x472EE6D6);
  /// rgba(185,179,217,.15)
  static const hairline = Color(0x26B9B3D9);
  /// rgba(185,179,217,.14)
  static const hairlineSoft = Color(0x24B9B3D9);

  // ── 圆角（卡片 18 / 按钮 16 / 药丸 999） ──────────────────
  static const rXs = 8.0;
  static const rS = 10.0;
  static const rM = 14.0;
  static const rL = 18.0;
  static const rXl = 22.0;

  // ── 常用渐变 ──────────────────────────────────────────────
  /// 面板：rgba(18,15,42,.7) → rgba(14,11,34,.52)
  static const panelGradient = LinearGradient(
    begin: Alignment.topCenter,
    end: Alignment.bottomCenter,
    colors: [Color(0xB3120F2A), Color(0x850E0B22)],
  );

  /// 卡片：rgba(255,255,255,.06) → rgba(16,13,40,.5)
  static const cardGradient = LinearGradient(
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
    colors: [Color(0x12FFFFFF), Color(0x80100D28)],
  );

  /// 主按钮：linear-gradient(180deg,#69f2e4,#22d9c8)
  static const accentGradient = LinearGradient(
    begin: Alignment.topCenter,
    end: Alignment.bottomCenter,
    colors: [tealLite, tealDeep],
  );

  /// 底景压暗（.grade 的那层）
  static const gradeGradient = LinearGradient(
    begin: Alignment.topCenter,
    end: Alignment.bottomCenter,
    stops: [0.0, 0.24, 0.62, 1.0],
    colors: [Color(0xA80A0818), Color(0x2E0A0818), Color(0x660A0818), Color(0xE6080612)],
  );

  static const mono = 'monospace';
}

class OctoText {
  const OctoText._();

  static const display = TextStyle(
    fontSize: 19, fontWeight: FontWeight.w700, color: Colors.white, letterSpacing: .2,
  );
  static const title = TextStyle(
    fontSize: 15, fontWeight: FontWeight.w600, color: Colors.white, height: 1.3,
  );
  static const body = TextStyle(fontSize: 13, height: 1.55, color: Octo.ink);
  static const bodyDim = TextStyle(fontSize: 12.5, height: 1.5, color: Octo.ink2);
  static const caption = TextStyle(fontSize: 11.5, height: 1.5, color: Octo.dim);

  static const mono9 = TextStyle(
    fontFamily: Octo.mono, fontSize: 9, letterSpacing: .8, color: Octo.dim, height: 1.4,
  );
  static const mono10 = TextStyle(
    fontFamily: Octo.mono, fontSize: 10, letterSpacing: .3, color: Octo.dim, height: 1.5,
  );
  static const mono11 = TextStyle(
    fontFamily: Octo.mono, fontSize: 11, color: Octo.metal, height: 1.6,
  );
  static const monoLabel = TextStyle(
    fontFamily: Octo.mono, fontSize: 9.5, fontWeight: FontWeight.w800,
    letterSpacing: 1.4, color: Octo.teal,
  );
}

ThemeData buildOctoTheme() {
  final base = ThemeData(
    useMaterial3: true,
    brightness: Brightness.dark,
    scaffoldBackgroundColor: Octo.screen,
    colorScheme: const ColorScheme.dark(
      primary: Octo.teal,
      secondary: Octo.tealDeep,
      surface: Octo.indigo,
      error: Octo.red,
      onPrimary: Color(0xFF06131A),
      onSurface: Octo.ink,
    ),
    splashFactory: InkSparkle.splashFactory,
  );
  return base.copyWith(
    textTheme: base.textTheme.apply(bodyColor: Octo.ink, displayColor: Colors.white),
    appBarTheme: const AppBarTheme(
      backgroundColor: Colors.transparent,
      elevation: 0,
      scrolledUnderElevation: 0,
      foregroundColor: Octo.ink,
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: const Color(0xAD100D28),
      hintStyle: const TextStyle(
        fontFamily: Octo.mono, fontSize: 11.5, color: Octo.dim,
      ),
      contentPadding: const EdgeInsets.symmetric(horizontal: 13, vertical: 13),
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(Octo.rM),
        borderSide: const BorderSide(color: Octo.hairline),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(Octo.rM),
        borderSide: const BorderSide(color: Octo.hairline),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(Octo.rM),
        borderSide: const BorderSide(color: Octo.edge, width: 1.2),
      ),
    ),
  );
}
