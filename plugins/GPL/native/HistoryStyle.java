package app.dariuss.logger;

import android.text.SpannableStringBuilder;
import android.text.Spanned;
import android.text.style.ForegroundColorSpan;
import android.text.style.RelativeSizeSpan;
import app.valenced.plugins.PluginBuilder;
import app.valenced.plugins.PluginScope;
import de.robv.android.xposed.XC_MethodHook;
import de.robv.android.xposed.XposedBridge;
import java.lang.reflect.Method;
import java.util.List;
import kotlin.Unit;
import kotlin.jvm.functions.Function1;

/** Styles only the logger's explicit ranges, preserving Discord's existing spans. */
public final class HistoryStyle {
    private static final String READY = "dariuss.ghost-ping-logger.historyReady";
    private static XC_MethodHook.Unhook hook;

    public static PluginBuilder getPlugin() {
        PluginBuilder builder = new PluginBuilder();
        builder.start(new Function1<PluginScope, Unit>() {
            public Unit invoke(PluginScope scope) {
                install(scope.getClassLoader());
                scope.getBridge().registerMethod(READY, new Function1<List<?>, Object>() {
                    public Object invoke(List<?> args) { return hook != null; }
                });
                return Unit.INSTANCE;
            }
        });
        builder.stop(new Function1<PluginScope, Unit>() {
            public Unit invoke(PluginScope scope) {
                if (hook != null) hook.unhook();
                hook = null;
                return Unit.INSTANCE;
            }
        });
        return builder;
    }

    private static void install(ClassLoader loader) {
        if (hook != null) return;
        try {
            Class<?> view = loader.loadClass("com.facebook.drawee.span.SimpleDraweeSpanTextView");
            Method setter = null;
            for (Method method : view.getDeclaredMethods()) {
                if (method.getName().equals("setDraweeSpanStringBuilder")) {
                    if (setter != null) throw new IllegalStateException("Ambiguous text setter");
                    setter = method;
                }
            }
            if (setter == null) throw new IllegalStateException("Message text setter unavailable");
            hook = XposedBridge.hookMethod(setter, new XC_MethodHook() {
                protected void beforeHookedMethod(MethodHookParam param) {
                    if (param.args.length == 0 || !(param.args[0] instanceof SpannableStringBuilder)) return;
                    SpannableStringBuilder text = (SpannableStringBuilder) param.args[0];
                    applyRanges(text, '\ue100', '\ue101', false);
                    applyRanges(text, '\ue102', '\ue103', true);
                }
            });
        } catch (Throwable error) {
            XposedBridge.log("Dariuss logger history styling: " + error);
        }
    }

    static void applyRanges(SpannableStringBuilder text, char open, char close, boolean small) {
        while (true) {
            String value = text.toString();
            int start = value.lastIndexOf(open);
            if (start < 0) return;
            int end = value.indexOf(close, start + 1);
            int separator = value.indexOf(';', start + 1);
            if (end < 0 || separator < 0 || separator >= end) {
                text.delete(start, start + 1);
                continue;
            }
            Integer color = null;
            try { color = Integer.valueOf(value.substring(start + 1, separator)); }
            catch (NumberFormatException ignored) {}
            text.delete(end, end + 1);
            text.delete(start, separator + 1);
            int contentEnd = start + end - separator - 1;
            if (contentEnd <= start) continue;
            if (color != null) text.setSpan(new ForegroundColorSpan(color), start, contentEnd, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
            if (small) text.setSpan(new RelativeSizeSpan(0.75f), start, contentEnd, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        }
    }
}
