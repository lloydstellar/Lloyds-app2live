package nl.lloydstellar.la2l;

import java.text.Normalizer;
import java.util.Locale;
import java.util.regex.Pattern;
import org.json.JSONArray;
import org.json.JSONObject;

// Text helpers ported from the device (src/node/text.js) and the web SDK, with the same results:
// names cleaned as the device cleans them, sizes as it writes them, and values read the way
// JavaScript reads them, so a description gets the same verdict here as on the server.
final class Text {
    private Text() {}

    private static final Pattern NOT_IN_NAME = Pattern.compile("[^\\p{L}\\p{N} _\\-().'&+#!]");
    // JavaScript's \s, which also takes the non-breaking space and the byte order mark.
    static final String JS_SPACE = "[\\t\\n\\u000B\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]";
    private static final Pattern JS_SPACES = Pattern.compile(JS_SPACE + "+");
    private static final Pattern JS_TRIM = Pattern.compile("^" + JS_SPACE + "+|" + JS_SPACE + "+$");

    /**
     * A track or clip name as the device makes it: letters and digits of any language, space and
     * {@code _ - ( ) . ' & + # !}. Anything else becomes a space, and the name is cut at maxLength.
     */
    static String cleanName(Object name, String fallback, int maxLength) {
        String s = Normalizer.normalize(jsString(name), Normalizer.Form.NFC);
        s = NOT_IN_NAME.matcher(s).replaceAll(" ");
        s = JS_SPACES.matcher(s).replaceAll(" ");
        s = jsTrim(s);
        if (s.length() > maxLength) s = jsTrim(s.substring(0, maxLength));
        return s.isEmpty() ? fallback : s;
    }

    /** 1693484 -> "1.6 MB", 210763776 -> "201 MB", as the device writes sizes. */
    static String megabytes(double bytes) {
        return String.format(Locale.ROOT, bytes < 10485760 ? "%.1f MB" : "%.0f MB", bytes / 1048576.0);
    }

    static String jsTrim(String s) {
        return JS_TRIM.matcher(s).replaceAll("");
    }

    /** What JavaScript's String(value) gives, with null and undefined as "". */
    static String jsString(Object v) {
        if (v == null || v == JSONObject.NULL) return "";
        if (v instanceof String) return (String) v;
        if (v instanceof Boolean) return v.toString();
        if (v instanceof Number) return jsNumber(((Number) v).doubleValue());
        if (v instanceof JSONArray) {
            JSONArray a = (JSONArray) v;
            StringBuilder out = new StringBuilder();
            for (int i = 0; i < a.length(); i++) {
                if (i > 0) out.append(',');
                Object item = a.opt(i);
                if (item != null && item != JSONObject.NULL) out.append(jsString(item));
            }
            return out.toString();
        }
        if (v instanceof JSONObject) return "[object Object]";
        return v.toString();
    }

    // A number as JavaScript prints it: 92, 92.5, 0.0005, 1152921504606847000, 1e+21. JavaScript
    // takes the fewest digits that give the same double back; so does this, on every Java.
    static String jsNumber(double d) {
        if (Double.isNaN(d)) return "NaN";
        if (Double.isInfinite(d)) return d > 0 ? "Infinity" : "-Infinity";
        if (d == 0) return "0";
        if (d == Math.rint(d) && Math.abs(d) < 9007199254740992.0) return String.valueOf((long) d);
        String fewest = null;
        for (int digits = 1; digits <= 17 && fewest == null; digits++) {
            String s = String.format(Locale.ROOT, "%." + (digits - 1) + "e", d);
            if (Double.parseDouble(s) == d) fewest = s;
        }
        if (fewest == null) fewest = String.format(Locale.ROOT, "%.16e", d);
        java.math.BigDecimal exact = new java.math.BigDecimal(fewest).stripTrailingZeros();
        double size = Math.abs(d);
        if (size >= 1e-6 && size < 1e21) return exact.toPlainString();
        String digits = exact.unscaledValue().abs().toString();
        int exponent = digits.length() - 1 - exact.scale();
        String mantissa = digits.length() > 1 ? digits.charAt(0) + "." + digits.substring(1) : digits;
        return (d < 0 ? "-" : "") + mantissa + "e" + (exponent > 0 ? "+" : "") + exponent;
    }

    /** JavaScript's truthiness: not null, false, 0, NaN or "". */
    static boolean truthy(Object v) {
        if (v == null || v == JSONObject.NULL) return false;
        if (v instanceof Boolean) return (Boolean) v;
        if (v instanceof String) return !((String) v).isEmpty();
        if (v instanceof Number) {
            double d = ((Number) v).doubleValue();
            return d != 0 && !Double.isNaN(d);
        }
        return true;
    }

    /** A finite number, as JavaScript's typeof v === 'number' and Number.isFinite(v). */
    static Double finite(Object v) {
        if (!(v instanceof Number)) return null;
        double d = ((Number) v).doubleValue();
        return Double.isFinite(d) ? d : null;
    }

    /** A whole number, as Number.isInteger(v). */
    static boolean isInteger(Object v) {
        Double d = finite(v);
        return d != null && d == Math.rint(d);
    }

    static String lower(String s) {
        return s.toLowerCase(Locale.ROOT);
    }
}
