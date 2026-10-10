// dsh-balance-monitor — browser half (client plugin bundle).
//
// Loaded by dsh-client-modules at /plugins/dsh-balance-monitor/client.js and
// executed through the vendored cordis Loader's lazy-CJS module table
// (window.__ModuleLoader__.load). The factory body is plain CJS with require()
// resolved against the shell's module table — the same shape the shipped ui-*
// packages' bundles emit.
//
// Features:
//   - 「余额 xxx￥」 row at the sidebar foot, directly above the Settings button
//     and styled exactly like it (same height, padding, radius, label color and
//     hover background), with a coin (金币) or money-bag (钱袋) icon on the left
//     and the amount right-aligned after the label.
//   - Manual refresh button (rotating arrow) pinned to the row's right edge; the
//     row itself is a refresh button too.
//   - Below 800px the sidebar collapses to a rail: the row degenerates to the
//     bare icon, matching the Settings rail button.
//   - 「设置 → 余额监控」page: live total, per-currency breakdown, balance trend
//     sparkline (host-recorded history), parameters, and diagnostics.
//
// All state flows through one module-level store (MONITOR_STATE) read with
// useSyncExternalStore, so the badge and the settings page never disagree.

window.__ModuleLoader__.load({
    id: "dsh-balance-monitor",
    factory: (require) => {
        var module = { exports: {} };
        var exports = module.exports;
        Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

        var react = require("react");
        // The shell's own dialog primitive. dsh-client-ui-primitives is a seeded
        // module materialized by the boot graph before any plugin bundle, so it is
        // always resolvable and its stylesheet is always claimed before ours.
        var primitives = require("@deepseek-ai/dsh-client-ui-primitives");
        var Modal = primitives.Modal;

        // -----------------------------------------------------------------------
        // Styles
        // -----------------------------------------------------------------------

        var CSS = [
            // The sidebar foot renders `sidebar.footer.action` before
            // `sidebar.settings`; this rule lifts our row onto its own full-width
            // line above the Settings button while keeping the shipped launcher
            // (registry button, etc.) on its own line below us.
            'div:has(> div[data-slot="sidebar.footer.action"]){flex-wrap:wrap}',
            'div:has(> div[data-slot="sidebar.footer.action"])>div[data-slot="sidebar.footer.action"]{flex:0 0 100%}',
            // Mirrors the Settings trigger row: same box, same hover, so the two
            // controls read as one group.
            //
            // The horizontal margin is load-bearing, not cosmetic. The native
            // settings row wraps its button in a `.triggerRow` carrying
            // `margin:4px -2px`, so the gear and 「设置」 start LEFT of the footer
            // slot's own content box, and this row must be pulled out to match.
            //
            // Tuned from pixel measurements of real screenshots. The offset is
            // scale-invariant, so shots captured at different render scales are
            // comparable:
            //
            //   pull   icon Δ   label Δ   row Δ
            //   -2px     +3       +4       +2
            //   -4px     -5       -4       -6
            //
            // That fits rowΔ ≈ 4 × pull + 10, so -2.5px puts icon and label at 0.
            // The leftover +1px at any given pull is the wallet artwork being 1px
            // wider than the gear, not a row offset. Do not "tidy" this to 0: it is
            // the only thing aligning the icon and the 余额 label with 设置.
            ".bm-row{box-sizing:border-box;border-radius:var(--dsw-radius-md);cursor:pointer;width:auto;min-width:0;height:42px;color:var(--dsw-alias-label-primary);background:0 0;border:none;flex:1;align-items:center;gap:8px;margin:0 -2.5px;padding:0 10px 0 8px;font-family:inherit;font-size:14px;line-height:22px;display:flex;overflow:hidden}",
            ".bm-row:hover{background:var(--dsw-alias-interactive-bg-hover)}",
            ".bm-row:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}",
            ".bm-row.bm-static{cursor:default}",
            ".bm-row.bm-static:hover{background:0 0}",
            // 16px in the wide sidebar — the exact icon edge the native Settings gear
            // uses (it renders size 16 when wide, 18 in the collapsed rail). An 18px
            // badge icon also nudged the 「余额」 label right by 2px.
            ".bm-icon{flex:none;display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px}",
            ".bm-label{white-space:nowrap;overflow:hidden}",
            // Peak/off-peak tag. A FIXED 26px column: the label changes with the hour
            // (高峰 / 低谷 / 周末) and an inline tag would shift the amount sideways.
            // 10px keeps it clearly secondary on a 42px row.
            //
            // `line-height:1` + `top:1.5px` are the vertical alignment, measured from
            // a screenshot: the row's `align-items:center` centres the tag on the
            // label's LINE box (mid y=45.5) while the 余额 glyphs' ink box centres at
            // y=46.5 and their visual body sits lower still — so the tag read as
            // riding high. line-height:1 keeps the tag box tight around its own text
            // instead of inheriting the row's 22px, and the 1.5px nudge lands the tag
            // on the glyphs' optical centre. Only `top` is used (no margin/height
            // change) so the row's layout and its 42px height are untouched.
            ".bm-phase{flex:none;position:relative;top:1.5px;display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;width:26px;height:16px;font-size:10px;line-height:1;font-weight:600;letter-spacing:.2px;border-radius:var(--dsw-radius-sm);white-space:nowrap;cursor:default;user-select:none}",
            // The theme ships no warning alias (the reference plugin only ever used
            // `--dsw-alias-state-warning-primary` with a hardcoded fallback), so the
            // peak colour is a literal; the rest come from theme variables.
            ".bm-phase-idle{color:var(--dsw-alias-state-success-primary);background:rgba(0,200,120,.10)}",
            ".bm-phase-peak{color:var(--dsw-alias-state-warning-primary,#ff8f1f);background:rgba(255,143,31,.12)}",
            ".bm-value{margin-left:auto;padding-left:8px;flex:none;font-variant-numeric:tabular-nums;font-weight:500;white-space:nowrap}",
            ".bm-value.bm-muted{color:var(--dsw-alias-label-tertiary);font-weight:400}",
            ".bm-value.bm-error{color:var(--dsw-alias-state-error-primary)}",
            // Amount typography: the official DeepSeek brand face, which DSH already
            // ships (montserrat-{light,regular,medium}.woff2) and exposes as
            // --dsw-font-family-brand. Montserrat defines only 300/400/500, so the
            // weight is 500 — asking for 600 would make the browser synthesise a
            // faux-bold, which is visibly muddier than the real Medium.
            //
            // The currency mark is NOT resized or recoloured: it renders at the same
            // size and colour as the digits, in whichever order the
            // `currencySymbol` setting asks for.
            ".bm-amount{display:inline-flex;align-items:baseline;font-family:var(--dsw-font-family-brand);font-weight:500}",
            ".bm-amount-symbol{font-weight:500}",
            ".bm-amount-symbol.bm-symbol-before{margin-right:1px}",
            ".bm-amount-symbol.bm-symbol-after{margin-left:1px}",
            ".bm-empty{width:14px;height:2px;border-radius:1px;background:var(--dsw-alias-label-tertiary);display:inline-block}",
            ".bm-refresh{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;margin:0 -2px 0 2px;flex:none;border:none;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;padding:0;border-radius:var(--dsw-radius-sm)}",
            ".bm-refresh:hover{color:var(--dsw-alias-label-primary)}",
            ".bm-refresh svg{width:13px;height:13px;display:block}",
            ".bm-refresh.bm-spin svg{animation:bm-rotate .5s ease-out}",
            "@keyframes bm-rotate{to{transform:rotate(360deg)}}",
            // ---- odometer ----
            // Each digit is a 22px window over a 1em-tall track. Rolling only the
            // digits keeps the amount's box height stable on a 42px row.
            //
            // The cell width is 1.06ch — the advance of the element's own "0" glyph
            // plus a hair of slack — rather than the .62em this used to be. .62em was
            // measured for the system UI font (digits ~0.55-0.6em); Montserrat's
            // digits are ~0.65em, so every cell clipped its glyph horizontally and the
            // RIGHTMOST digit showed it worst (no neighbour to hide the cut). 1ch
            // tracks whatever face is actually loaded, so a font swap cannot
            // reintroduce the clip; the +6% absorbs the slight overshoot of round
            // glyphs like 0/8 past their nominal advance.
            ".bm-digits{display:inline-flex;align-items:center;font-variant-numeric:tabular-nums}",
            ".bm-cell{display:inline-block;overflow:hidden;height:22px;line-height:22px;text-align:center;width:1.06ch;vertical-align:top}",
            ".bm-cell-static{overflow:visible;width:auto}",
            ".bm-cell-track{display:block;height:22px;line-height:22px}",
            ".bm-cell-item{display:block;height:22px;line-height:22px;text-align:center}",
            "@keyframes bm-roll-up{0%{transform:var(--bm-from,translateY(1em));color:var(--dsw-alias-state-success-primary)}60%{color:var(--dsw-alias-state-success-primary)}100%{transform:none;color:var(--dsw-alias-label-primary)}}",
            "@keyframes bm-roll-down{0%{transform:var(--bm-from,translateY(-1em));color:var(--dsw-alias-state-error-primary)}60%{color:var(--dsw-alias-state-error-primary)}100%{transform:none;color:var(--dsw-alias-label-primary)}}",
            // The custom property must sit on the animated element itself (a var()
            // inside a keyframe resolves against the animated element, not an
            // ancestor), so each direction sets its own --bm-from on the track.
            //
            // --bm-delay staggers the positions (see RollDigits): the cells do not
            // all roll at once, each position starts a little after the one to its
            // right, which is what makes it read as a mechanical odometer instead of
            // one block sliding. `backwards` makes a cell that is still waiting hold
            // the start state instead of flashing the final value.
            ".bm-cell.bm-roll-up .bm-cell-track{--bm-from:translateY(1em);animation:bm-roll-up var(--bm-dur,.85s) cubic-bezier(.2,.75,.3,1) var(--bm-delay,0s) backwards}",
            ".bm-cell.bm-roll-down .bm-cell-track{--bm-from:translateY(-1em);animation:bm-roll-down var(--bm-dur,.85s) cubic-bezier(.2,.75,.3,1) var(--bm-delay,0s) backwards}",
            "@media (prefers-reduced-motion:reduce){.bm-cell.bm-roll-up .bm-cell-track,.bm-cell.bm-roll-down .bm-cell-track{animation:none}}",
            // Collapsed rail: the icon alone, sized like the shipped rail buttons.
            ".bm-row.bm-rail{flex:none;justify-content:center;gap:0;width:36px;height:36px;padding:0}",
            ".bm-row.bm-rail .bm-label,.bm-row.bm-rail .bm-value{display:none}",
            ".bm-row.bm-rail .bm-icon{width:18px;height:18px}", // ---- settings section ----
            ".bm-section{max-width:720px;width:100%;box-sizing:border-box;color:var(--dsw-alias-label-primary);flex-direction:column;gap:12px;display:flex;padding:4px 0 24px}",
            ".bm-head{flex-direction:column;gap:4px;display:flex}",
            ".bm-title{margin:0;font-size:16px;font-weight:500;line-height:24px}",
            ".bm-intro{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}",
            ".bm-card{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;flex-direction:column;gap:10px;padding:12px 14px;display:flex;background:var(--dsw-alias-bg-base)}",
            ".bm-card-head{flex:none;align-items:center;justify-content:space-between;gap:8px;display:flex}",
            ".bm-card-title{font-size:13px;font-weight:600;line-height:20px}",
            ".bm-live-main{flex:none;align-items:baseline;gap:6px;display:flex;flex-wrap:wrap}",
            ".bm-live-dot{width:9px;height:9px;border-radius:50%;flex:none;display:inline-block;margin-right:2px;background:var(--dsw-alias-label-tertiary)}",
            ".bm-live-dot.bm-dot-ok{background:var(--dsw-alias-state-success-primary)}",
            ".bm-live-dot.bm-dot-error{background:var(--dsw-alias-state-error-primary)}",
            ".bm-live-num{font-family:var(--dsw-font-family-brand);font-size:30px;font-weight:500;line-height:1.1;font-variant-numeric:tabular-nums}",
            ".bm-live-cur{flex:none;font-size:10px;font-weight:600;color:var(--dsw-alias-label-tertiary);border:1px solid var(--dsw-alias-border-l2);border-radius:5px;padding:1px 5px;line-height:14px}",
            ".bm-live-meta{flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;gap:12px;display:flex;flex-wrap:wrap}",
            ".bm-live-ok{color:var(--dsw-alias-state-success-primary)}",
            ".bm-live-err{color:var(--dsw-alias-state-error-primary)}",
            ".bm-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:28px;flex:none;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);border-radius:var(--dsw-radius-sm);padding:0 10px;font-size:12px;line-height:26px;font-family:inherit}",
            ".bm-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}",
            ".bm-btn:disabled{opacity:.55;cursor:default;background:transparent}",
            ".bm-btn svg{width:13px;height:13px;display:block}",
            ".bm-btn.bm-spin svg{animation:bm-rotate .5s ease-out}",
            ".bm-cur-list{flex:none;flex-direction:column;gap:2px;display:flex;border-top:1px solid var(--dsw-alias-border-l2);padding-top:8px}",
            ".bm-cur-row{flex:none;align-items:center;justify-content:space-between;gap:8px;display:flex;font-size:13px;line-height:20px;padding:3px 8px;border-radius:8px}",
            ".bm-cur-row.bm-cur-on{background:var(--dsw-alias-interactive-bg-hover)}",
            ".bm-cur-left{display:flex;align-items:baseline;gap:8px;min-width:0}",
            ".bm-cur-code{color:var(--dsw-alias-label-secondary);font-weight:600}",
            ".bm-cur-tag{color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:14px;border:1px solid var(--dsw-alias-border-l2);border-radius:5px;padding:0 4px}",
            ".bm-cur-value{font-variant-numeric:tabular-nums;flex:none}",
            ".bm-chart{width:100%;position:relative}",
            ".bm-chart svg{display:block}",
            ".bm-chart-axis{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;justify-content:space-between;display:flex;margin-top:2px}",
            ".bm-chart-stats{flex:none;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;display:flex;gap:14px;flex-wrap:wrap}",
            ".bm-chart-empty{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;padding:24px 0;text-align:center}",
            ".bm-hover-tip{position:absolute;top:-6px;transform:translateX(-50%);z-index:2;pointer-events:none;background:var(--dsw-alias-tooltip-bg);border-radius:var(--dsw-radius-sm);padding:3px 8px;color:var(--dsw-static-neutral-bluish-00);font-size:11px;line-height:16px;white-space:nowrap;box-shadow:0 6px 18px rgba(0,0,0,.35)}",
            ".bm-hover-tip.bm-flip{transform:translateX(-92%)}",
            ".bm-hover-time{opacity:.65}",
            ".bm-hover-val{font-weight:600;font-variant-numeric:tabular-nums}",
            ".bm-range{flex:none;gap:4px;display:inline-flex}",
            ".bm-range-btn{box-sizing:border-box;height:24px;cursor:pointer;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-tertiary);border-radius:var(--dsw-radius-sm);padding:0 8px;font-size:11px;line-height:22px;font-family:inherit}",
            ".bm-range-btn:hover{color:var(--dsw-alias-label-primary)}",
            ".bm-range-btn.bm-on{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}",
            // ---- 额度消耗趋势 dialog (sidebar row click) ----
            // The shipped Modal pins its card to `width:min(380px,100%)` inside
            // Modal.module.css. Growing it needs equal-or-higher specificity AND a
            // later position in the cascade: the shell claims every client bundle's
            // <style> in dependency order, and dsh-client-ui-primitives — which owns
            // that rule — is a seed this bundle requires, so it is always claimed
            // first. That is why this needs no !important.
            ".bm-trend-dialog{width:min(560px,100%)}",
            // The modal's own body column is `padding:0 24px`; these rows add the
            // vertical rhythm instead, so the head/tabs/foot keep one inset.
            ".bm-trend-body{flex-direction:column;gap:12px;display:flex;width:100%;min-width:0}",
            ".bm-trend-tabs{flex-wrap:wrap;gap:4px;display:flex}",
            // The dialog's own header already names the card, so the currency picker
            // is a plain row instead of a second title.
            ".bm-trend-cur{flex:none;align-items:center;justify-content:space-between;gap:8px;display:flex;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",
            ".bm-trend-note{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;margin:0}",
            ".bm-trend-stats{gap:8px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}",
            ".bm-trend-stat{box-sizing:border-box;flex-direction:column;gap:2px;min-width:0;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;display:flex;background:var(--dsw-alias-bg-base)}",
            ".bm-trend-stat-label{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
            ".bm-trend-stat-value{font-family:var(--dsw-font-family-brand);font-size:15px;line-height:22px;font-weight:500;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
            ".bm-trend-up{color:var(--dsw-alias-state-success-primary)}",
            ".bm-trend-down{color:var(--dsw-alias-state-error-primary)}",
            ".bm-row-set{box-sizing:border-box;flex:none;align-items:center;justify-content:space-between;gap:12px;min-height:40px;padding:6px 0;border-top:1px solid var(--dsw-alias-border-l2);display:flex;cursor:pointer}",
            ".bm-card>.bm-row-set:first-of-type{border-top:none}",
            ".bm-row-label{flex-direction:column;gap:2px;min-width:0;display:flex}",
            ".bm-row-title{font-size:13px;line-height:20px}",
            ".bm-row-hint{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}",
            ".bm-switch{box-sizing:border-box;width:36px;height:20px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-interactive-bg-hover);cursor:pointer;flex:none;padding:0;position:relative;transition:background .18s ease}",
            ".bm-switch .bm-knob{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-label-tertiary);transition:transform .18s ease,background .18s ease}",
            ".bm-switch.bm-on{background:var(--dsw-alias-state-success-primary);border-color:transparent}",
            ".bm-switch.bm-on .bm-knob{transform:translateX(16px);background:#fff}",
            ".bm-input{box-sizing:border-box;width:84px;height:28px;flex:none;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);padding:0 8px;font-size:13px;text-align:right;font-family:inherit}",
            ".bm-input:focus{outline:none;border-color:var(--dsw-alias-state-success-primary)}",
            ".bm-select{box-sizing:border-box;height:28px;flex:none;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);padding:0 6px;font-size:13px;font-family:inherit;cursor:pointer}",
            ".bm-seg{flex:none;display:inline-flex;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);overflow:hidden}",
            ".bm-seg-btn{box-sizing:border-box;height:26px;cursor:pointer;border:none;background:transparent;color:var(--dsw-alias-label-tertiary);padding:0 10px;font-size:12px;line-height:24px;font-family:inherit;display:inline-flex;align-items:center;gap:4px}",
            ".bm-seg-btn+.bm-seg-btn{border-left:1px solid var(--dsw-alias-border-l2)}",
            ".bm-seg-btn:hover{color:var(--dsw-alias-label-primary)}",
            ".bm-seg-btn.bm-on{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
            ".bm-seg-btn svg{width:13px;height:13px;display:block}",
            // Icon collection picker: one tile per collected glyph, so the choice is
            // made by looking at the artwork rather than by guessing a name.
            ".bm-icons{flex:none;display:grid;grid-template-columns:repeat(auto-fill,minmax(62px,1fr));gap:6px}",
            ".bm-icons-btn{box-sizing:border-box;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:var(--dsw-radius-sm);padding:7px 2px 5px;font-family:inherit;display:flex;flex-direction:column;align-items:center;gap:4px;min-width:0}",
            ".bm-icons-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
            ".bm-icons-btn.bm-on{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}",
            ".bm-icons-glyph{flex:none;display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px}",
            ".bm-icons-name{font-size:10px;line-height:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}",
            ".bm-diag-note{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}",
            ".bm-config-error{flex:none;font-size:12px;line-height:18px;padding:6px 10px;border-radius:8px;color:var(--dsw-alias-state-error-primary);background:rgba(255,80,80,.08)}",
            ".bm-diag-help{flex:none;align-items:center;gap:8px;display:flex;flex-wrap:wrap;margin-top:2px}",
            ".bm-diag-text{flex:1 1 auto;min-width:0;box-sizing:border-box;font-size:12px;line-height:18px;font-family:var(--ds-font-family-code);color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);padding:5px 8px;user-select:all;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
            "@media (prefers-reduced-motion:reduce){.bm-refresh.bm-spin svg,.bm-btn.bm-spin svg{animation:none}}",
        ].join("\n");

        var CSS_TAG = "dsh-balance-monitor";
        if (
            typeof document !== "undefined" &&
            document.querySelector(
                'style[data-plugin-css="' + CSS_TAG + '"]',
            ) === null
        ) {
            var styleTag = document.createElement("style");
            styleTag.setAttribute("data-plugin-css", CSS_TAG);
            styleTag.textContent = CSS;
            (document.head || document.documentElement).appendChild(styleTag);
        }

        // -----------------------------------------------------------------------
        // Icon collection (16x16 grid, currentColor, 1.3px stroke, round caps)
        //
        // Deliberately self-contained: every glyph is one or two dozen path
        // characters drawn on the same 16px grid and stroke weight as the shipped
        // outline set (IconSettingsOutline*), so the badge reads as part of the
        // native footer. Nothing here depends on an icon package being installed.
        //
        // Geometry note: the native gear artwork spans radius ~6.08 inside its 16px
        // box, so artwork that touches r=6.35 reads noticeably larger. Glyphs below
        // stay at r<=6.1 to keep the same optical weight as the gear beside them.
        // -----------------------------------------------------------------------

        /** Wrap artwork in the shared 16px, 1.3px-stroke, currentColor frame. */
        function iconFrame(children) {
            return react.createElement(
                "svg",
                {
                    viewBox: "0 0 16 16",
                    width: "100%",
                    height: "100%",
                    fill: "none",
                    xmlns: "http://www.w3.org/2000/svg",
                    "aria-hidden": "true",
                    strokeWidth: 1.3,
                    stroke: "currentColor",
                    strokeLinecap: "round",
                    strokeLinejoin: "round",
                },
                children,
            );
        }

        /** Shorthand: build one path child. */
        function p(key, d) {
            return react.createElement("path", { key: key, d: d });
        }

        /** Shorthand: build one circle child. */
        function c(key, cx, cy, r) {
            return react.createElement("circle", {
                key: key,
                cx: cx,
                cy: cy,
                r: r,
            });
        }

        /** The ￥ mark (two diagonals, a stem, two bars) fitted into a coin. */
        function yuanMark() {
            return [
                p("y1", "M6.5 5.6 8 7.5l1.5-1.9"),
                p("y2", "M8 7.5v4"),
                p("y3", "M6.4 8.4h3.2"),
                p("y4", "M6.4 9.6h3.2"),
            ];
        }

        /**
         * The icon collection. Keys are the persisted `icon` config values.
         * `tone: 'solid'` glyphs are filled at render time for contrast.
         */
        var ICONS = [
            {
                id: "coin",
                label: "金币",
                draw: function () {
                    return [c("o", 8, 8, 6.1), c("i", 8, 8, 4.5)].concat(
                        yuanMark(),
                    );
                },
            },
            {
                id: "coins",
                label: "金币堆",
                draw: function () {
                    return [
                        react.createElement("ellipse", {
                            key: "a",
                            cx: 6.6,
                            cy: 3.9,
                            rx: 3.3,
                            ry: 1.5,
                        }),
                        p(
                            "b",
                            "M3.1 3.9v2.2c0 .83 1.5 1.5 3.3 1.5.35 0 .69-.02 1-.06",
                        ),
                        p(
                            "c",
                            "M4.3 9.9c0 .83 1.5 1.5 3.3 1.5s3.3-.67 3.3-1.5v-1.9",
                        ),
                        p("d", "M4.3 7.9v2"),
                        p(
                            "e",
                            "M11.2 6.5c1.8 0 3.2.67 3.2 1.5v2.1c0 .83-1.4 1.5-3.2 1.5s-3.3-.67-3.3-1.5",
                        ),
                        p("f", "M14.4 10V8c0-.83-1.4-1.5-3.2-1.5"),
                    ];
                },
            },
            {
                id: "bag",
                label: "钱袋",
                draw: function () {
                    return [
                        p(
                            "p",
                            "M5.75 4.5c-.3 2.5-2.95 3.6-2.95 6.2 0 1.85 1.8 3.1 5.2 3.1s5.2-1.25 5.2-3.1c0-2.6-2.65-3.7-2.95-6.2",
                        ),
                        p(
                            "n",
                            "M5.75 4.5c.7-.45 1.45-.7 2.25-.7s1.55.25 2.25.7",
                        ),
                    ].concat(yuanMark());
                },
            },
            {
                id: "wallet",
                label: "钱包",
                draw: function () {
                    // Artwork spans x 1.9..14.1 — deliberately the same optical extent as
                    // the native gear (2.75..13.25 is narrower, but a wallet reads wider by
                    // shape), and 0.2px tighter than the collection's default drawer so the
                    // 「余额」 label lands on the same x as 「设置」. Measured: a 13.05px-wide
                    // wallet put the label 1px right of the settings label.
                    return [
                        p(
                            "a",
                            "M1.9 4.7c0-.88.72-1.6 1.6-1.6h7.7c.88 0 1.6.72 1.6 1.6v.3",
                        ),
                        p(
                            "b",
                            "M1.9 4.7v6.6c0 .88.72 1.6 1.6 1.6h9.0c.88 0 1.6-.72 1.6-1.6V6.3c0-.88-.72-1.6-1.6-1.6H3.5",
                        ),
                        p(
                            "c",
                            "M14.1 8.4h-2.95c-.66 0-1.2.54-1.2 1.2s.54 1.2 1.2 1.2h2.95",
                        ),
                    ];
                },
            },
            {
                id: "purse",
                label: "手拿包",
                draw: function () {
                    return [
                        p(
                            "a",
                            "M2.1 7.4c0-.7.55-1.25 1.25-1.25h9.3c.7 0 1.25.55 1.25 1.25v4.55c0 1-.8 1.8-1.8 1.8H3.9c-1 0-1.8-.8-1.8-1.8z",
                        ),
                        p(
                            "b",
                            "M5.6 6.15 7.1 2.6c.15-.35.6-.5.95-.35l.3.15c.35.15.5.6.35.95L7.9 6.15",
                        ),
                        p("c", "M6.1 8.5h3.8"),
                    ];
                },
            },
            {
                id: "card",
                label: "银行卡",
                draw: function () {
                    return [
                        react.createElement("rect", {
                            key: "a",
                            x: 1.7,
                            y: 3.6,
                            width: 12.6,
                            height: 8.8,
                            rx: 1.4,
                        }),
                        p("b", "M1.7 6.6h12.6"),
                        p("c", "M4.1 9.7h2.6"),
                    ];
                },
            },
            {
                id: "yuan",
                label: "人民币",
                draw: function () {
                    return [
                        p("a", "M4.6 5.2 8 9.1l3.4-3.9"),
                        p("b", "M8 9.1v4.3"),
                        p("c", "M4.5 10.3h7"),
                        p("d", "M4.5 12.1h7"),
                    ];
                },
            },
            {
                id: "dollar",
                label: "美元",
                draw: function () {
                    return [
                        p("a", "M8 1.9v12.2"),
                        p(
                            "b",
                            "M11.05 4.9c0-1.15-1.15-1.9-3.05-1.9s-3.05.75-3.05 1.9S6.1 6.8 8 6.8s3.05.75 3.05 1.9-1.15 1.9-3.05 1.9-3.05-.75-3.05-1.9",
                        ),
                    ];
                },
            },
            {
                id: "euro",
                label: "欧元",
                draw: function () {
                    return [
                        // Two quadratic arcs. The control offsets use the circle
                        // approximation constant k = 4/3*(sqrt(2)-1) ~= 0.5523, so the curve
                        // rounds like a circle without bulging past the 16px box.
                        p("a", "M12.4 4.2Q2.94 8 12.4 11.8"),
                        p("b", "M2.9 6.8h6.4"),
                        p("c", "M2.9 9.2h6.4"),
                    ];
                },
            },
            {
                id: "pound",
                label: "英镑",
                draw: function () {
                    return [
                        p("a", "M4.6 12.9h7.3"),
                        p(
                            "b",
                            "M9.7 12.9c-1.1 0-2-.9-2-2V7.4c0-1.6 1.3-2.9 2.9-2.9.85 0 1.6.35 2.15.9",
                        ),
                        p("c", "M5.3 8.6h4.3"),
                    ];
                },
            },
            {
                id: "bank",
                label: "银行",
                draw: function () {
                    return [
                        p("a", "M2 6.4 8 2.5l6 3.9"),
                        p("b", "M3.5 6.4v6.1"),
                        p("c", "M6.6 6.4v6.1"),
                        p("d", "M9.4 6.4v6.1"),
                        p("e", "M12.5 6.4v6.1"),
                        p("f", "M2.2 13.5h11.6"),
                    ];
                },
            },
            {
                id: "safe",
                label: "保险箱",
                draw: function () {
                    return [
                        react.createElement("rect", {
                            key: "a",
                            x: 2,
                            y: 2.6,
                            width: 12,
                            height: 10.8,
                            rx: 1.4,
                        }),
                        c("b", 7.1, 8, 2.5),
                        p("c", "M7.1 5.9v-1"),
                        p("d", "M7.1 11.1v-1"),
                        p("e", "M5 8h-1"),
                        p("f", "M10.2 8h1"),
                        p("g", "M12.2 6.6v2.8"),
                    ];
                },
            },
            {
                id: "safe2",
                label: "金库",
                draw: function () {
                    return [
                        p("a", "M8 1.9 2.3 7.6V14h11.4V7.6z"),
                        c("b", 8, 9.1, 2.1),
                        p("c", "M8 7.9v2.4"),
                    ];
                },
            },
            {
                id: "chart",
                label: "涨势图",
                draw: function () {
                    return [
                        p("a", "M2.3 12.9h11.4"),
                        p("b", "M2.3 12.9 5.6 9.4l2.5 2.1 5-5.5"),
                        p("c", "M10.6 6h2.5v2.5"),
                    ];
                },
            },
            {
                id: "tag",
                label: "价签",
                draw: function () {
                    return [
                        p(
                            "a",
                            "M6.9 2.4h5.1c.6 0 1.1.5 1.1 1.1v5.1c0 .3-.12.6-.33.81l-5.3 5.3c-.45.45-1.18.45-1.63 0L2.4 11.3c-.45-.45-.45-1.18 0-1.63l5.3-5.3c.21-.21.5-.33.81-.33z",
                        ),
                        p("b", "M10.4 5.6h.01"),
                    ];
                },
            },
            {
                id: "gift",
                label: "礼包",
                draw: function () {
                    return [
                        // Symmetric two-arc bow over a 2.5..13.5 box, matching the gear's
                        // half-extent of ~6.08 rather than overhanging it.
                        react.createElement("rect", {
                            key: "a",
                            x: 2.5,
                            y: 5.9,
                            width: 11,
                            height: 7.6,
                            rx: 1.1,
                        }),
                        p("b", "M1.85 5.9h12.3"),
                        p("c", "M8 5.9v7.6"),
                        p("d", "M8 5.9Q2.85 3.9 5.2 2.6Q7.4 1.5 8 5.9z"),
                        p("e", "M8 5.9Q13.15 3.9 10.8 2.6Q8.6 1.5 8 5.9z"),
                    ];
                },
            },
            {
                id: "shopping",
                label: "购物袋",
                draw: function () {
                    return [
                        p(
                            "a",
                            "M3.2 5.2h9.6l.85 8.1c.05.5-.35.9-.85.9H3.2c-.5 0-.9-.4-.85-.9z",
                        ),
                        p("b", "M5.9 7.1V4.6a2.1 2.1 0 0 1 4.2 0v2.5"),
                    ];
                },
            },
            {
                id: "sack",
                label: "钱袋（F）",
                draw: function () {
                    return [
                        p(
                            "a",
                            "M6.1 2.1h3.8l-.4 2.1c.9.7 3.2 1.9 3.2 4.9 0 3.1-1.9 4.8-4.7 4.8S3.3 12.2 3.3 9.1c0-3 2.3-4.2 3.2-4.9z",
                        ),
                        p("b", "M6.1 2.1c-.3.9-.3 1.5-.4 2.1"),
                        p("c", "M9.9 2.1c.3.9.3 1.5.4 2.1"),
                    ];
                },
            },
            {
                id: "safe3",
                label: "宝箱",
                draw: function () {
                    return [
                        p(
                            "a",
                            "M2 7.2c0-2 2.7-3.6 6-3.6s6 1.6 6 3.6v4.3c0 .8-.7 1.4-1.5 1.4h-9c-.8 0-1.5-.6-1.5-1.4z",
                        ),
                        p("b", "M2 7.2h12"),
                        p("c", "M8 7.2v3.4"),
                        p("d", "M6.9 8.9h2.2"),
                    ];
                },
            },
        ];

        var ICON_IDS = ICONS.map(function (entry) {
            return entry.id;
        });

        /** Look an icon up by id, falling back to the first entry (金币). */
        function iconDef(id) {
            for (var i = 0; i < ICONS.length; i++) {
                if (ICONS[i].id === id) return ICONS[i];
            }
            return ICONS[0];
        }

        /** Render one collected icon by id at the shared frame size. */
        function iconFor(id) {
            return iconFrame(iconDef(id).draw());
        }

        /** 刷新：two arrows around a gap. */
        function RefreshIcon() {
            return iconFrame([
                p("a", "M13.4 8a5.4 5.4 0 0 1-9.22 3.82"),
                p("b", "M2.6 8a5.4 5.4 0 0 1 9.22-3.82"),
                p("c", "M11.85 1.9v2.35h-2.35"),
                p("d", "M4.15 14.1v-2.35h2.35"),
            ]);
        }

        // -----------------------------------------------------------------------
        // Store: config + live balance + history, shared by badge and settings page
        // -----------------------------------------------------------------------

        var DEFAULTS = {
            showBadge: true,
            autoRefresh: true,
            refreshInterval: 30,
            showRefreshButton: true,
            showTrend: true,
            displayCurrency: "auto",
            icon: "wallet",
            rollDuration: 0.85, // 数字滚动时长（秒）
            rollStagger: 0.04, // 相邻数位开始滚动的间隔（秒）
            showPhaseTag: true, // 余额行显示「高峰 / 低谷 / 周末」时段标签
            currencySymbol: "after", // 货币符号位置：after / before / none
        };

        var MONITOR_STATE = {
            config: null, // merged config; null until the first successful load
            balances: null, // [{ currency, balance, granted, toppedUp, total, available }] or null
            currency: null, // primary currency code (CNY preferred, else the first)
            available: null, // account-level is_available from the official API, or null
            phase: null, // { phase, label, hint } peak/off-peak, computed by the host
            spend: null, // { CNY, USD } real billed spend measured by the host
            history: [], // [{ t, balances: { CNY: .. } }] recorded by the host
            health: null, // GET /balance-monitor/health body, or null
            error: null, // last balance error message, or null
            configError: null, // last rejected parameter save, or null
            lastUpdated: null, // ms timestamp of the last successful fetch
            oldValue: null, // previously displayed amount (roll animation baseline)
            rollDirections: null, // per-character roll direction of the last change
            rollToken: 0, // increments per changed value; drives the refreshed-only spin
            // ---- trend dialog (sidebar row click) ----
            trendOpen: false, // the 额度消耗趋势 dialog is showing
            trendRange: "1h", // selected period tab id (see RANGE_OPTIONS)
            trendCurrency: null, // pinned currency of the dialog, or null = follow the display
            fetching: false,
            fetchStartedAt: 0,
            spin: 0, // 0 = the arrow has never animated (avoids an animation on mount)
            revision: 0,
        };

        var listeners = new Set();

        function getSnapshot() {
            return MONITOR_STATE;
        }

        function subscribe(fn) {
            listeners.add(fn);
            return function () {
                listeners.delete(fn);
            };
        }

        function update(patch) {
            MONITOR_STATE = Object.assign({}, MONITOR_STATE, patch, {
                revision: MONITOR_STATE.revision + 1,
            });
            for (var fn of Array.from(listeners)) {
                try {
                    fn();
                } catch (err) {
                    // A broken subscriber must never break the store.
                }
            }
        }

        /** Read the store in a component through React's external-store contract. */
        function useMonitor() {
            return react.useSyncExternalStore(
                subscribe,
                getSnapshot,
                getSnapshot,
            );
        }

        // -----------------------------------------------------------------------
        // Trend dialog commands
        //
        // The open flag and the selected period live in the store, not in the
        // badge's local state: they survive the badge unmounting (turning 显示侧边栏
        // 余额 off would otherwise yank the dialog away mid-click) and the chart
        // keeps its period while a background refresh replaces the samples.
        // -----------------------------------------------------------------------

        /** Open the 额度消耗趋势 dialog. */
        function openTrend() {
            update({ trendOpen: true });
        }

        /** Close it. */
        function closeTrend() {
            update({ trendOpen: false });
        }

        /** Select a period tab; an unknown id is ignored rather than stored. */
        function selectTrendRange(id) {
            if (
                !RANGE_OPTIONS.some(function (o) {
                    return o.id === id;
                })
            )
                return;
            update({ trendRange: id });
        }

        /** Pin the dialog (and the badge) to one currency. */
        function selectTrendCurrency(code) {
            if (typeof code !== "string") return;
            update({ trendCurrency: code });
        }

        // -----------------------------------------------------------------------
        // Host transport
        //
        // Web profile: relative '/balance-monitor/*' paths reach the host's web
        // server. Electron Desktop: the Desktop Host answers unknown `dsh-app://`
        // paths with the SPA HTML, so the host half publishes
        // `window.__BALANCE_MONITOR_HOST__ = { origin, token, ports }` through the
        // index-injection hook and this module routes every call to that loopback
        // origin with the per-process token.
        // -----------------------------------------------------------------------

        var HOST_INFO =
            typeof window !== "undefined" &&
            window.__BALANCE_MONITOR_HOST__ !== null &&
            typeof window.__BALANCE_MONITOR_HOST__ === "object"
                ? window.__BALANCE_MONITOR_HOST__
                : null;
        /** Loopback ports the host half tries, in the same order (lib/index.js). */
        var LOOPBACK_PORTS = [
            17881, 17882, 17883, 17884, 17885, 17886, 17887, 17888, 17889,
            17890,
        ];
        var hostBase = null; // resolved origin; '' means same-origin (Web profile)
        var hostProbe = null; // in-flight port probe
        var transportError = null; // last transport-level failure (diagnostics)

        /** Advertised token, or '' when the page never received the injection. */
        function hostToken() {
            return HOST_INFO !== null && typeof HOST_INFO.token === "string"
                ? HOST_INFO.token
                : "";
        }

        function probeHostPorts() {
            var ports =
                HOST_INFO !== null &&
                Array.isArray(HOST_INFO.ports) &&
                HOST_INFO.ports.length > 0
                    ? HOST_INFO.ports
                    : LOOPBACK_PORTS;
            var token = hostToken();
            var index = 0;
            function next() {
                if (index >= ports.length) {
                    transportError =
                        "本机 " +
                        ports[0] +
                        "-" +
                        ports[ports.length - 1] +
                        " 端口没有响应";
                    return "";
                }
                var base = "http://127.0.0.1:" + ports[index++];
                return fetch(base + "/balance-monitor/health", {
                    cache: "no-store",
                })
                    .then(function (r) {
                        return r.ok ? r.json() : null;
                    })
                    .then(function (body) {
                        if (
                            body !== null &&
                            typeof body === "object" &&
                            body.ok === true
                        ) {
                            if (token !== "") {
                                hostBase = base;
                                transportError = null;
                                return base;
                            }
                            transportError =
                                "宿主已找到（" +
                                base +
                                "）但页面缺少注入的访问令牌";
                            return "";
                        }
                        return next();
                    })
                    .catch(function () {
                        return next();
                    });
            }
            return Promise.resolve().then(next);
        }

        function resolveHostBase() {
            if (hostBase !== null) return Promise.resolve(hostBase);
            if (HOST_INFO === null) {
                var plain =
                    typeof location === "undefined" ||
                    location.protocol === "http:" ||
                    location.protocol === "https:";
                if (plain) {
                    hostBase = "";
                    return Promise.resolve("");
                }
                if (hostProbe === null) {
                    hostProbe = probeHostPorts().then(function () {
                        hostBase = "";
                        return hostBase;
                    });
                }
                return hostProbe;
            }
            if (
                typeof HOST_INFO.origin === "string" &&
                HOST_INFO.origin !== ""
            ) {
                hostBase = HOST_INFO.origin;
                return Promise.resolve(hostBase);
            }
            if (hostProbe === null) hostProbe = probeHostPorts();
            return hostProbe;
        }

        /** fetch() against the host, adding the loopback origin + token when needed. */
        function monitorFetch(path, init) {
            return resolveHostBase().then(function (base) {
                var url = base + path;
                if (base !== "") {
                    var token = hostToken();
                    if (token !== "")
                        url +=
                            (path.indexOf("?") === -1 ? "?" : "&") +
                            "token=" +
                            encodeURIComponent(token);
                }
                return fetch(url, init);
            });
        }

        // -----------------------------------------------------------------------
        // Formatting
        // -----------------------------------------------------------------------

        /** Currency symbol for the trailing-symbol display style (1234.50￥). */
        function symbolOf(currency) {
            if (currency === "CNY") return "￥";
            if (currency === "USD") return "$";
            if (currency === "EUR") return "€";
            if (currency === "GBP") return "£";
            if (currency === "JPY") return "¥";
            return currency;
        }

        /** Zero-decimal currencies (and other whole-unit currencies). */
        function decimalsOf(currency) {
            return currency === "JPY" ||
                currency === "KRW" ||
                currency === "VND"
                ? 0
                : 2;
        }

        /** Group the integer part with thin commas. */
        function grouped(intText) {
            return intText.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
        }

        /**
         * Format an amount as `<number><symbol>` — e.g. `12.69￥`, `1,234.50￥`.
         * The symbol trails the number, matching the display the user asked for.
         *
         * Callers that can style the two parts separately should prefer
         * {@link formatAmountDigits} + {@link formatAmountSymbol}: the official
         * DeepSeek balance card renders its currency mark far smaller and lighter
         * than the digits (measured on a screenshot: a 9px-tall ￥ against 42px
         * digits, ≈0.21×), which is what makes the number read as the subject.
         */
        function formatAmount(value, currency, withSymbol) {
            if (typeof value !== "number" || !Number.isFinite(value))
                return "--";
            return (
                amountDigits(value, currency) +
                (withSymbol === false ? "" : symbolOf(currency))
            );
        }

        /** The numeric part of an amount: grouped, with the currency's decimals. */
        function amountDigits(value, currency) {
            if (typeof value !== "number" || !Number.isFinite(value))
                return "--";
            var decimals = decimalsOf(currency);
            var negative = value < 0;
            var fixed = Math.abs(value).toFixed(decimals);
            var parts = fixed.split(".");
            var text =
                grouped(parts[0]) + (parts.length > 1 ? "." + parts[1] : "");
            return (negative ? "-" : "") + text;
        }

        /** The currency mark for an amount, rendered as its own span. */
        function amountSymbol(currency) {
            return symbolOf(currency);
        }

        /**
         * Currency-symbol placement options, mirroring the host's SYMBOL_POSITIONS.
         * The labels show the resulting shape, so the choice needs no explanation.
         */
        var SYMBOL_OPTIONS = [
            {
                id: "after",
                label: "12.69￥",
                hint: "符号显示在金额之后（默认）",
            },
            { id: "before", label: "￥12.69", hint: "符号显示在金额之前" },
            { id: "none", label: "不显示", hint: "只显示数字，不显示货币符号" },
        ];

        /** Normalise a stored `currencySymbol` value to one of SYMBOL_OPTIONS. */
        function symbolPosition(value) {
            for (var i = 0; i < SYMBOL_OPTIONS.length; i++) {
                if (SYMBOL_OPTIONS[i].id === value) return value;
            }
            return "after";
        }

        function fmtTime(ms) {
            if (typeof ms !== "number") return "--";
            var d = new Date(ms);
            return (
                ("0" + d.getHours()).slice(-2) +
                ":" +
                ("0" + d.getMinutes()).slice(-2) +
                ":" +
                ("0" + d.getSeconds()).slice(-2)
            );
        }

        function fmtShort(ms) {
            var d = new Date(ms);
            return (
                ("0" + d.getHours()).slice(-2) +
                ":" +
                ("0" + d.getMinutes()).slice(-2)
            );
        }

        function fmtDay(ms) {
            var d = new Date(ms);
            return d.getMonth() + 1 + "/" + d.getDate() + " " + fmtShort(ms);
        }

        /**
         * Resolve which currency the badge shows (auto = CNY, else the first).
         *
         * `trendCurrency` pins BOTH the badge and the trend dialog once the dialog
         * has offered a currency picker, so switching the chart there can never
         * leave the sidebar row showing a different currency than the chart.
         */
        function resolveDisplay(snap) {
            var cfg = snap.config === null ? DEFAULTS : snap.config;
            var list = snap.balances;
            if (!Array.isArray(list) || list.length === 0)
                return { value: null, currency: "CNY", entry: null };
            var pinned =
                typeof snap.trendCurrency === "string"
                    ? snap.trendCurrency
                    : null;
            var want =
                pinned !== null
                    ? pinned
                    : cfg.displayCurrency === "auto"
                      ? list.some(function (b) {
                            return b.currency === "CNY";
                        })
                          ? "CNY"
                          : list[0].currency
                      : cfg.displayCurrency;
            var entry = list.find(function (b) {
                return b.currency === want;
            });
            if (entry === undefined) {
                entry =
                    list.find(function (b) {
                        return b.currency === "CNY";
                    }) || list[0];
            }
            return {
                value: entry.balance,
                currency: entry.currency,
                entry: entry,
            };
        }

        /**
         * Points of one currency's balance, in host order.
         *
         * @param sinceMs - optional lower bound on the sample timestamp.
         * @param withCarry - when set, also keep the newest sample that sits BEFORE
         *                    `sinceMs`. That sample is where the window's opening
         *                    balance comes from: the first sample inside the window
         *                    only reports the balance after everything spent
         *                    between the two, so without it the window would
         *                    silently drop that spend.
         */
        function historyPoints(snap, currency, sinceMs, withCarry) {
            var out = [];
            if (!Array.isArray(snap.history)) return out;
            for (var i = 0; i < snap.history.length; i++) {
                var h = snap.history[i];
                if (
                    h === null ||
                    typeof h !== "object" ||
                    typeof h.t !== "number"
                )
                    continue;
                var value =
                    h.balances !== null && typeof h.balances === "object"
                        ? h.balances[currency]
                        : undefined;
                if (typeof value !== "number" || !Number.isFinite(value))
                    continue;
                if (typeof sinceMs === "number" && h.t < sinceMs) {
                    if (withCarry === true) out = [{ t: h.t, value: value }];
                    continue;
                }
                out.push({ t: h.t, value: value });
            }
            return out;
        }

        /**
         * The window's opening point plus every point inside the window.
         *
         * The carried point is tagged `carry` so a chart can drop it (it sits left
         * of the window) while the usage math still counts it as the baseline.
         */
        function historyWindowPoints(snap, currency, sinceMs) {
            var all = historyPoints(snap, currency, sinceMs, true);
            if (all.length === 0) return [];
            var out = [];
            for (var i = 0; i < all.length; i++) {
                out.push({
                    t: all[i].t,
                    value: all[i].value,
                    carry: typeof sinceMs === "number" && all[i].t < sinceMs,
                });
            }
            return out;
        }

        /**
         * Keep one point per time bucket — the LAST sample in each bucket, i.e. the
         * remaining quota at the end of that bucket.
         *
         * Buckets are floored to real clock boundaries (a 6h window buckets by the
         * hour, a 7d window by the local day) so the x-axis reads as calendar time
         * instead of as offsets from whenever the dialog was opened.
         *
         * @param bucketMs - bucket width; when absent/0 the points pass through.
         */
        function bucketPoints(points, bucketMs) {
            if (!Array.isArray(points) || points.length === 0) return [];
            if (
                typeof bucketMs !== "number" ||
                !Number.isFinite(bucketMs) ||
                bucketMs <= 0
            ) {
                return points.map(function (p) {
                    return { t: p.t, value: p.value, bucket: p.t };
                });
            }
            var out = [];
            var current = null;
            for (var i = 0; i < points.length; i++) {
                var p = points[i];
                var key = Math.floor(p.t / bucketMs) * bucketMs;
                if (current !== null && current.bucket === key) {
                    // Later sample wins: the bucket stands for the balance it ended at.
                    current.t = p.t;
                    current.value = p.value;
                    continue;
                }
                current = { t: p.t, value: p.value, bucket: key };
                out.push(current);
            }
            return out;
        }

        /**
         * What the account actually burned inside a window.
         *
         * The official API exposes no usage history, so consumption is the sum of
         * the balance DECREASES between consecutive samples; an increase is a
         * top-up (or a grant), never negative consumption. Because the consume and
         * top-up sums are measured separately, `consumed + toppedUp` equals the net
         * change of the window exactly — a top-up can never be silently counted as
         * spend the way a `first - last` subtraction would.
         *
         * @returns `{ start, end, consumed, toppedUp, net, samples, spanMs, perHour }`
         *          with `null` amounts for an empty window.
         */
        function periodUsage(points) {
            var usable = Array.isArray(points) ? points : [];
            var empty = {
                start: null,
                end: null,
                consumed: 0,
                toppedUp: 0,
                net: 0,
                samples: 0,
                spanMs: 0,
                perHour: null,
            };
            if (usable.length === 0) return empty;
            var consumed = 0;
            var toppedUp = 0;
            for (var i = 1; i < usable.length; i++) {
                var delta = round2(usable[i].value - usable[i - 1].value);
                if (delta < 0) consumed += -delta;
                else if (delta > 0) toppedUp += delta;
            }
            var first = usable[0];
            var last = usable[usable.length - 1];
            var spanMs = Math.max(0, last.t - first.t);
            return {
                start: first.value,
                end: last.value,
                consumed: round2(consumed),
                toppedUp: round2(toppedUp),
                net: round2(consumed - toppedUp),
                samples: usable.length,
                spanMs: spanMs,
                // Burn rate over the sampled span; null while the span is too short to
                // extrapolate from (a single sample, or a burst inside one minute).
                perHour:
                    spanMs >= 60000
                        ? round2(consumed / (spanMs / 3600000))
                        : null,
            };
        }

        /** Round to fen (2 decimals) without float drift — mirrors the host helper. */
        function round2(n) {
            return Math.round(Number(n) * 100) / 100;
        }

        /** Shortest tick that still reads as clock time, for a chart's x-axis. */
        function hasClockTicks(spanMs) {
            return spanMs < 172800000; // under 48h: HH:MM is unambiguous
        }

        /** A `MM/DD` tick or tooltip time — the form for multi-day windows. */
        function fmtMonthDay(ms) {
            var d = new Date(ms);
            return d.getMonth() + 1 + "/" + d.getDate();
        }

        /** The x-axis/tooltip time formatter for a window of `spanMs`. */
        function timeAxisFor(spanMs) {
            return hasClockTicks(spanMs) ? fmtShort : fmtMonthDay;
        }

        function fmtDuration(ms) {
            var minutes = Math.max(0, Math.round(ms / 60000));
            if (minutes < 60) return minutes + " 分钟";
            var hours = minutes / 60;
            if (hours < 48) return Math.round(hours * 10) / 10 + " 小时";
            return Math.round((hours / 24) * 10) / 10 + " 天";
        }

        // -----------------------------------------------------------------------
        // Data loading
        // -----------------------------------------------------------------------

        var loopTimer = null;

        /**
         * (Re)start the single auto-refresh timer that serves both the badge and the
         * settings page. Module-owned: the settings page never stops it on unmount.
         */
        function startLoop() {
            if (loopTimer !== null) {
                clearInterval(loopTimer);
                loopTimer = null;
            }
            var cfg = MONITOR_STATE.config;
            if (cfg === null || !cfg.autoRefresh) return;
            var ms = Math.max(
                5000,
                Math.min(3600000, Math.round(cfg.refreshInterval) * 1000),
            );
            loopTimer = setInterval(function () {
                void refreshBalance(false);
            }, ms);
        }

        /**
         * Fetch the balance from the host.
         * @param manual - true for a user-triggered refresh: bypasses the host cache
         *                 and plays the refresh spin animation.
         */
        function refreshBalance(manual) {
            var now = Date.now();
            if (
                MONITOR_STATE.fetching &&
                now - MONITOR_STATE.fetchStartedAt < 20000
            )
                return Promise.resolve();
            update({ fetching: true, fetchStartedAt: now });
            var path = "/balance-monitor/balance" + (manual ? "?force=1" : "");
            return monitorFetch(path, { cache: "no-store" })
                .then(function (r) {
                    return r.json();
                })
                .then(function (data) {
                    if (data === null || typeof data !== "object") {
                        update({ error: "宿主返回了无法解析的数据" });
                        return;
                    }
                    if (
                        Array.isArray(data.balances) &&
                        data.balances.length > 0
                    ) {
                        // Roll only when the *displayed* amount actually moved, and spin the
                        // arrow on exactly the same condition — "余额没有变化时右侧刷新图标不动".
                        var view = {
                            config: MONITOR_STATE.config,
                            balances: data.balances,
                            currency: data.currency,
                            available: data.available,
                        };
                        var next = resolveDisplay(view);
                        var roll = rollDirectionsFor(
                            MONITOR_STATE.oldValue,
                            next.value,
                            next.currency,
                        );
                        var directions = roll.changed ? roll.directions : null;
                        var rollToken = roll.changed
                            ? MONITOR_STATE.rollToken + 1
                            : MONITOR_STATE.rollToken;
                        var spin = roll.changed
                            ? MONITOR_STATE.spin + 1
                            : MONITOR_STATE.spin;
                        update({
                            balances: data.balances,
                            currency: data.currency,
                            available:
                                typeof data.available === "boolean"
                                    ? data.available
                                    : null,
                            phase:
                                data.phase !== null &&
                                typeof data.phase === "object" &&
                                typeof data.phase.phase === "string"
                                    ? {
                                          phase: data.phase.phase,
                                          label: String(data.phase.label),
                                          hint: String(data.phase.hint),
                                      }
                                    : MONITOR_STATE.phase,
                            spend:
                                data.spend !== null &&
                                typeof data.spend === "object"
                                    ? data.spend
                                    : MONITOR_STATE.spend,
                            error: null,
                            lastUpdated: Date.now(),
                            oldValue: next.value,
                            rollDirections: directions,
                            rollToken: rollToken,
                            spin: spin,
                        });
                        // Keep the history mirror fresh so the trend chart follows live.
                        void loadConfig(false);
                        return;
                    }
                    update({
                        error:
                            typeof data.error === "string"
                                ? data.error
                                : "查询失败",
                    });
                })
                .catch(function (err) {
                    update({
                        error:
                            "宿主不可达（" +
                            String(
                                err !== null &&
                                    typeof err === "object" &&
                                    err.message !== undefined
                                    ? err.message
                                    : err,
                            ) +
                            "）",
                    });
                })
                .finally(function () {
                    update({ fetching: false });
                });
        }

        /** Merge a host config response over the client defaults. */
        function normalizeConfig(config) {
            var merged = Object.assign({}, DEFAULTS);
            if (config !== null && typeof config === "object") {
                for (var k of Object.keys(DEFAULTS)) {
                    if (config[k] !== undefined) merged[k] = config[k];
                }
            }
            return merged;
        }

        /** Load parameters + history (+ optionally balances) from the host. */
        function loadConfig(withBalances) {
            return monitorFetch("/balance-monitor/config", {
                cache: "no-store",
            })
                .then(function (r) {
                    return r.json();
                })
                .then(function (data) {
                    if (
                        data === null ||
                        typeof data !== "object" ||
                        data.config === null ||
                        typeof data.config !== "object"
                    )
                        return null;
                    update({
                        config: normalizeConfig(data.config),
                        history: Array.isArray(data.history)
                            ? data.history
                            : [],
                        spend:
                            data.spend !== null &&
                            typeof data.spend === "object"
                                ? data.spend
                                : MONITOR_STATE.spend,
                    });
                    startLoop();
                    return data;
                })
                .catch(function (err) {
                    transportError = String(
                        err !== null &&
                            typeof err === "object" &&
                            err.message !== undefined
                            ? err.message
                            : err,
                    );
                    update({ error: "宿主不可达（" + transportError + "）" });
                    return null;
                })
                .then(function (result) {
                    if (
                        withBalances !== false &&
                        MONITOR_STATE.balances === null
                    )
                        return refreshBalance(false);
                    return result;
                });
        }

        /** Persist a parameter patch; the response carries the merged config back. */
        function saveConfig(patch) {
            return monitorFetch("/balance-monitor/config", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(patch),
                cache: "no-store",
            })
                .then(function (r) {
                    // A rejected patch used to be swallowed: the host answers 400 with a
                    // reason, and without this the picker/toggle simply appeared inert.
                    return r.json().then(function (data) {
                        return { ok: r.ok, status: r.status, data: data };
                    });
                })
                .then(function (result) {
                    var data = result.data;
                    if (
                        result.ok &&
                        data !== null &&
                        typeof data === "object" &&
                        data.config !== null &&
                        typeof data.config === "object"
                    ) {
                        update({
                            config: normalizeConfig(data.config),
                            history: Array.isArray(data.history)
                                ? data.history
                                : MONITOR_STATE.history,
                            configError: null,
                        });
                        startLoop();
                    } else if (!result.ok) {
                        update({
                            configError:
                                data !== null &&
                                typeof data === "object" &&
                                typeof data.error === "string"
                                    ? data.error
                                    : "宿主拒绝了这次修改（HTTP " +
                                      result.status +
                                      "）",
                        });
                    }
                    return data;
                })
                .catch(function (err) {
                    update({
                        configError:
                            "保存失败：" +
                            String(
                                err !== null &&
                                    typeof err === "object" &&
                                    err.message !== undefined
                                    ? err.message
                                    : err,
                            ),
                    });
                    return null;
                });
        }

        /** Clear the host history + spend ledger. */
        function resetHistory() {
            return monitorFetch("/balance-monitor/reset", {
                method: "POST",
                cache: "no-store",
            })
                .then(function (r) {
                    return r.json();
                })
                .then(function (data) {
                    if (
                        data !== null &&
                        typeof data === "object" &&
                        data.ok === true
                    ) {
                        update({ history: [], spend: { CNY: 0, USD: 0 } });
                    }
                    return data;
                })
                .catch(function () {
                    return null;
                });
        }

        /** Refresh the host diagnostics shown by the settings page. */
        function loadHealth() {
            return monitorFetch("/balance-monitor/health", {
                cache: "no-store",
            })
                .then(function (r) {
                    return r.json();
                })
                .then(function (data) {
                    if (
                        data !== null &&
                        typeof data === "object" &&
                        data.ok === true
                    )
                        update({ health: data });
                    return data;
                })
                .catch(function (err) {
                    update({
                        health: {
                            ok: false,
                            error: String(
                                err !== null &&
                                    typeof err === "object" &&
                                    err.message !== undefined
                                    ? err.message
                                    : err,
                            ),
                        },
                    });
                    return null;
                });
        }

        // -----------------------------------------------------------------------
        // Odometer digits
        //
        // Each character cell holds a 1em-tall window over a track. On a value
        // change every changed cell swaps in a fresh element carrying `bm-roll-up`
        // or `bm-roll-down`, so the CSS animation replays from the start; a class
        // that merely stayed applied would animate only once. Unchanged cells keep
        // their element (no new key) and therefore cannot flash.
        // -----------------------------------------------------------------------

        /**
         * Map per-digit roll directions onto character positions of the rendered
         * text.
         *
         * `directions` is indexed over the DIGITS of the value (right-aligned),
         * while `text` also carries thousands separators and the currency symbol.
         * Exposed on the module exports so the browser half's roll behaviour can be
         * unit-tested without a real DOM.
         *
         * @param text - the formatted amount, e.g. "1,234.50￥".
         * @param directions - per-digit directions (1 up, -1 down, 0 unchanged).
         * @returns one direction per character position of `text`.
         */
        function mapDirections(text, directions) {
            var out = [];
            var digitIndex = 0;
            for (var i = 0; i < String(text).length; i++) {
                var ch = String(text)[i];
                var isDigit = ch >= "0" && ch <= "9";
                out.push(
                    isDigit && Array.isArray(directions)
                        ? directions[digitIndex++] || 0
                        : 0,
                );
            }
            return out;
        }

        /**
         * Per-digit roll directions for one value change.
         *
         * Both amounts are rendered through the same formatter and compared
         * right-aligned, so a length change (9.99 -> 10.02) does not shift every
         * cell and report a false "all digits moved".
         *
         * @param prev - previous amount.
         * @param next - new amount.
         * @param currency - currency code driving the symbol and decimals.
         * @returns { changed, directions } — directions indexed over digits.
         */
        function rollDirectionsFor(prev, next, currency) {
            if (
                typeof prev !== "number" ||
                typeof next !== "number" ||
                prev === next
            ) {
                return { changed: false, directions: null };
            }
            var prevDigits = formatAmount(prev, currency).replace(
                /[^0-9]/g,
                "",
            );
            var nextDigits = formatAmount(next, currency).replace(
                /[^0-9]/g,
                "",
            );
            var width = Math.max(prevDigits.length, nextDigits.length);
            var paddedPrev = prevDigits.padStart(width, "0");
            var paddedNext = nextDigits.padStart(width, "0");
            var up = next > prev;
            var directions = [];
            for (var i = 0; i < width; i++) {
                directions.push(
                    paddedPrev[i] === paddedNext[i] ? 0 : up ? 1 : -1,
                );
            }
            return { changed: true, directions: directions };
        }

        /**
         * Per-cell animation delay, in seconds, for the odometer stagger.
         *
         * The roll has to lead with the least-significant digit — the one whose
         * change actually caused the carry — so the delay grows as the cell sits
         * further LEFT of the units position. It counts DIGITS to the right, not
         * characters: a thousands separator or decimal point must not consume a
         * step, or `1,234.50` would spread twice as wide as its four-digit cousins.
         *
         * @param index - character position within the rendered text.
         * @param text - the full rendered text.
         * @param step - seconds between adjacent digit positions.
         * @returns the delay in seconds (0 for the rightmost digit).
         */
        function rollDelay(index, text, step) {
            var digitsRight = 0;
            for (var i = index + 1; i < text.length; i++) {
                if (text[i] >= "0" && text[i] <= "9") digitsRight += 1;
            }
            return digitsRight * step;
        }

        function RollDigits(props) {
            var text =
                typeof props.text === "string"
                    ? props.text
                    : String(props.text);
            var dirByPos = mapDirections(text, props.directions);
            var token = props.token;
            var duration =
                typeof props.duration === "number" ? props.duration : 0.85;
            var stagger = typeof props.stagger === "number" ? props.stagger : 0;

            var cells = [];
            for (var i = 0; i < text.length; i++) {
                var ch = text[i];
                var digit = ch >= "0" && ch <= "9";
                var dir = dirByPos[i];
                // Intl.NumberFormat would emit U+00A0 for a group separator; normalise
                // it so a non-digit cell never arrives as a surprise glyph.
                if (ch === "\u00a0") ch = ",";

                var classes = ["bm-cell"];
                if (!digit) classes.push("bm-cell-static");
                if (dir > 0) classes.push("bm-roll-up");
                else if (dir < 0) classes.push("bm-roll-down");

                // A changed cell gets a fresh element (new key) so the animation
                // restarts; unchanged cells keep their element and only their text
                // updates, which cannot animate and therefore cannot flash.
                var key =
                    dir === 0
                        ? "c" + i + ":" + ch
                        : "c" + i + ":" + ch + ":" + token;

                // Only a rolling cell carries a delay; a static one never animates.
                var cellStyle =
                    dir === 0
                        ? undefined
                        : {
                              "--bm-delay":
                                  rollDelay(i, text, stagger).toFixed(3) + "s",
                          };

                cells.push(
                    react.createElement(
                        "span",
                        {
                            className: classes.join(" "),
                            key: key,
                            style: cellStyle,
                        },
                        react.createElement(
                            "span",
                            { className: "bm-cell-track" },
                            react.createElement(
                                "span",
                                { className: "bm-cell-item" },
                                ch,
                            ),
                        ),
                    ),
                );
            }

            return react.createElement(
                "span",
                {
                    className: "bm-digits",
                    style: { "--bm-dur": duration + "s" },
                },
                cells,
            );
        }

        /**
         * An amount: rolling digits, plus the currency mark in the position the
         * `currencySymbol` setting asks for.
         *
         * @param value - the numeric amount.
         * @param currency - currency code driving decimals and the mark.
         * @param position - 'after' (12.69￥, default), 'before' (￥12.69) or 'none'.
         */
        function AmountValue(props) {
            var currency = props.currency;
            var value = props.value;
            var position = symbolPosition(props.position);

            if (typeof value !== "number" || !Number.isFinite(value)) {
                return react.createElement(
                    "span",
                    { className: "bm-amount" },
                    amountDigits(value, currency),
                );
            }

            var digits = react.createElement(RollDigits, {
                key: "digits",
                text: amountDigits(value, currency),
                directions: props.directions,
                token: props.token,
                duration: props.duration,
                stagger: props.stagger,
            });

            if (position === "none") {
                return react.createElement(
                    "span",
                    { className: "bm-amount" },
                    digits,
                );
            }

            var symbol = react.createElement(
                "span",
                {
                    key: "sym",
                    className: "bm-amount-symbol bm-symbol-" + position,
                },
                amountSymbol(currency),
            );

            return react.createElement(
                "span",
                { className: "bm-amount" },
                position === "before" ? [symbol, digits] : [digits, symbol],
            );
        }

        /**
         * Re-render on a wall-clock cadence.
         *
         * The peak/off-peak tag is a property of the current time, so it must
         * change even when no fetch happens (a failing or paused refresh would
         * otherwise leave a stale 「高峰」 on screen). Both the badge and the
         * settings page use this; the host recomputes the phase on every read.
         */
        function usePhaseClock(intervalMs) {
            var state = react.useState(0);
            var setTick = state[1];
            react.useEffect(
                function () {
                    var timer = setInterval(function () {
                        setTick(function (n) {
                            return n + 1;
                        });
                    }, intervalMs);
                    return function () {
                        clearInterval(timer);
                    };
                },
                [intervalMs],
            );
            return state[0];
        }

        /** The phase tag, or null when hidden / unknown. Renders at a fixed width. */
        function PhaseTag(props) {
            var phase = props.phase;
            if (
                phase === null ||
                typeof phase !== "object" ||
                typeof phase.phase !== "string"
            )
                return null;
            var cls =
                phase.phase === "peak" ? "bm-phase-peak" : "bm-phase-idle";
            return react.createElement(
                "span",
                {
                    className: "bm-phase " + cls,
                    key: "phase",
                    title:
                        typeof phase.hint === "string" ? phase.hint : undefined,
                },
                String(phase.label),
            );
        }

        function BadgeComponent(props) {
            var snap = useMonitor();
            // 30s matches the tag's granularity: windows change on the minute, so a
            // finer tick would only burn renders.
            usePhaseClock(30000);
            var compact =
                props !== null &&
                typeof props === "object" &&
                props.wide === false;
            var cfg = snap.config === null ? DEFAULTS : snap.config;
            var display = resolveDisplay(snap);
            var interactive =
                cfg.showBadge !== false && cfg.autoRefresh !== false;
            var busy = snap.fetching === true;

            var classes = ["bm-row"];
            if (compact) classes.push("bm-rail");
            if (!interactive) classes.push("bm-static");

            var valueClasses = ["bm-value"];
            if (display.value === null) {
                valueClasses.push(
                    snap.error !== null ? "bm-error" : "bm-muted",
                );
            }

            var children = [
                react.createElement(
                    "span",
                    { className: "bm-icon", key: "icon" },
                    iconFor(cfg.icon),
                ),
                react.createElement(
                    "span",
                    { className: "bm-label", key: "label" },
                    "余额",
                ),
            ];

            // The tag sits between the label and the value, so it reads as a
            // qualifier of the balance rather than of the amount.
            if (cfg.showPhaseTag !== false) {
                children.push(
                    react.createElement(PhaseTag, {
                        phase: snap.phase,
                        key: "phase-tag",
                    }),
                );
            }

            if (display.value === null) {
                children.push(
                    react.createElement(
                        "span",
                        { className: valueClasses.join(" "), key: "value" },
                        snap.error !== null
                            ? compact
                                ? "!"
                                : "读取失败"
                            : react.createElement("span", {
                                  className: "bm-empty",
                              }),
                    ),
                );
            } else {
                children.push(
                    react.createElement(
                        "span",
                        { className: valueClasses.join(" "), key: "value" },
                        react.createElement(AmountValue, {
                            value: display.value,
                            currency: display.currency,
                            position: cfg.currencySymbol,
                            directions: snap.rollDirections,
                            token: snap.rollToken,
                            duration:
                                typeof cfg.rollDuration === "number"
                                    ? cfg.rollDuration
                                    : DEFAULTS.rollDuration,
                            stagger:
                                typeof cfg.rollStagger === "number"
                                    ? cfg.rollStagger
                                    : DEFAULTS.rollStagger,
                        }),
                    ),
                );
            }

            if (!compact && cfg.showRefreshButton !== false) {
                children.push(
                    react.createElement(
                        "button",
                        {
                            // Only a *changed* balance animates: `rollToken` increments when the
                            // fetched value differs from the last one and stays put otherwise, so
                            // a refresh that returns the same number leaves the arrow still.
                            key: "refresh-" + snap.rollToken,
                            type: "button",
                            className:
                                "bm-refresh" +
                                (snap.spin > 0 ? " bm-spin" : ""),
                            "aria-label": "刷新余额",
                            title: "刷新余额",
                            disabled: busy,
                            onClick: function (event) {
                                event.stopPropagation();
                                void refreshBalance(true);
                            },
                        },
                        react.createElement(RefreshIcon),
                    ),
                );
            }

            var title =
                snap.error !== null
                    ? "余额监控：" + snap.error + " · 点击查看额度消耗趋势"
                    : "查看额度消耗趋势" +
                      (snap.lastUpdated !== null
                          ? " · 最后更新 " + fmtTime(snap.lastUpdated)
                          : "");

            return react.createElement(
                interactive ? "button" : "div",
                {
                    type: interactive ? "button" : undefined,
                    className: classes.join(" "),
                    title: title,
                    "aria-label": title,
                    // 点击整行打开额度消耗趋势弹窗；行右侧的刷新箭头仍然是「立即刷新余额」。
                    onClick: interactive
                        ? function () {
                              openTrend();
                          }
                        : undefined,
                },
                children,
            );
        }

        // -----------------------------------------------------------------------
        // 额度消耗趋势 dialog — opened by clicking the sidebar balance row
        //
        // The remaining-quota curve over a selectable window, plus what the account
        // actually burned inside it. Rendered through the shell's own Modal
        // primitive (dsh-client-ui-primitives is a seeded module the boot graph
        // always provides) so it inherits the native mask, elevation, Escape /
        // mask-click close, focus trap and focus return instead of re-implementing
        // them. Only the card width and the inner rows are ours.
        // -----------------------------------------------------------------------

        var CLOSE_LABEL = "关闭";

        function TrendStat(props) {
            return react.createElement(
                "div",
                { className: "bm-trend-stat" },
                react.createElement(
                    "span",
                    { className: "bm-trend-stat-label" },
                    props.label,
                ),
                react.createElement(
                    "span",
                    {
                        className:
                            "bm-trend-stat-value" +
                            (props.tone === undefined ? "" : " " + props.tone),
                    },
                    props.value,
                ),
            );
        }

        /**
         * The dialog body.
         *
         * Reads the same store as the badge, so a background refresh updates the
         * curve under the open dialog and the two can never disagree.
         */
        function TrendDialog() {
            var snap = useMonitor();
            var display = resolveDisplay(snap);
            var currency = display.currency;
            // The snapshot at render time. Deliberately read directly rather than
            // driven by a ticking clock: a live-updating `since` would re-slice the
            // window on every render, so the consumption total would creep upward
            // while the dialog sits open for no reason the user can see.
            var now = Date.now();

            var balances = Array.isArray(snap.balances) ? snap.balances : [];
            var options =
                balances.length > 0 ? balances : [{ currency: currency }];

            var range = snap.trendRange;
            var option = RANGE_OPTIONS.find(function (o) {
                return o.id === range;
            });
            if (option === undefined) option = RANGE_OPTIONS[0];
            var since = option.ms === null ? undefined : now - option.ms;

            // Usage uses the carried baseline; the CURVE must not, because the carry
            // sample belongs to a bucket that already holds a real in-window sample
            // and would land on (and distort) that bucket's value.
            var window_ = historyWindowPoints(snap, currency, since);
            var usage = periodUsage(window_);
            var curve = window_.filter(function (p) {
                return p.carry !== true;
            });
            var chartPoints = bucketPoints(curve, option.bucketMs);

            var domain = null;
            if (typeof since === "number") domain = { from: since, to: now };
            else if (curve.length > 1)
                domain = { from: curve[0].t, to: curve[curve.length - 1].t };
            var span =
                domain === null
                    ? usage.spanMs > 0
                        ? usage.spanMs
                        : 1
                    : domain.to - domain.from;

            var consumed = usage.consumed;
            var consumedLabel =
                consumed > 0
                    ? formatAmount(consumed, currency)
                    : "0" + symbolOf(currency);

            // The burn rate is the number that says what the remaining quota is doing
            // right now, so it is the one cell allowed to carry a tone.
            var rateTone = "bm-trend-up";
            if (usage.perHour !== null && usage.perHour > 0)
                rateTone = "bm-trend-down";
            var rateValue =
                usage.perHour === null
                    ? "采样不足"
                    : formatAmount(usage.perHour, currency) + " / 小时";

            return react.createElement(
                Modal,
                {
                    open: true,
                    onClose: function () {
                        closeTrend();
                    },
                    title: "账户余额",
                    closeLabel: CLOSE_LABEL,
                    className: "bm-trend-dialog",
                    description:
                        "每次刷新时采样一次，消耗额度按采样点之间的余额下降量累加",
                },
                react.createElement(
                    "div",
                    { className: "bm-trend-body" },
                    balances.length > 1
                        ? react.createElement(
                              "div",
                              { className: "bm-trend-cur" },
                              react.createElement("span", null, "币种"),
                              react.createElement(
                                  "select",
                                  {
                                      className: "bm-select",
                                      value: currency,
                                      onChange: function (e) {
                                          selectTrendCurrency(e.target.value);
                                      },
                                  },
                                  options.map(function (item) {
                                      return react.createElement(
                                          "option",
                                          {
                                              key: item.currency,
                                              value: item.currency,
                                          },
                                          item.currency,
                                      );
                                  }),
                              ),
                          )
                        : null,
                    react.createElement(
                        "div",
                        { className: "bm-trend-tabs", role: "tablist" },
                        RANGE_OPTIONS.filter(function (o) {
                            return TREND_TABS.indexOf(o.id) !== -1;
                        }).map(function (o) {
                            var on = o.id === option.id;
                            return react.createElement(
                                "button",
                                {
                                    key: o.id,
                                    type: "button",
                                    role: "tab",
                                    "aria-selected": on,
                                    className:
                                        "bm-range-btn" + (on ? " bm-on" : ""),
                                    onClick: function () {
                                        selectTrendRange(o.id);
                                    },
                                },
                                o.label,
                            );
                        }),
                    ),
                    chartPoints.length === 0
                        ? react.createElement(
                              "div",
                              { className: "bm-chart-empty" },
                              "这段区间还没有采样数据，等待下一次刷新…",
                          )
                        : react.createElement(
                              "div",
                              null,
                              react.createElement(Sparkline, {
                                  points: chartPoints,
                                  symbol: currency,
                                  width: 512,
                                  height: 150,
                                  tFor: timeAxisFor(span),
                                  domain: domain,
                              }),
                              react.createElement(
                                  "div",
                                  { className: "bm-chart-stats" },
                                  react.createElement(
                                      "span",
                                      null,
                                      "区间最低 " +
                                          formatAmount(
                                              Math.min.apply(
                                                  null,
                                                  chartPoints.map(function (p) {
                                                      return p.value;
                                                  }),
                                              ),
                                              currency,
                                          ),
                                  ),
                                  react.createElement(
                                      "span",
                                      null,
                                      "最高 " +
                                          formatAmount(
                                              Math.max.apply(
                                                  null,
                                                  chartPoints.map(function (p) {
                                                      return p.value;
                                                  }),
                                              ),
                                              currency,
                                          ),
                                  ),
                              ),
                          ),
                    react.createElement(
                        "div",
                        { className: "bm-trend-stats" },
                        react.createElement(TrendStat, {
                            label: "区间消耗",
                            value: consumedLabel,
                            tone: consumed > 0 ? "bm-trend-down" : undefined,
                        }),
                        react.createElement(TrendStat, {
                            label: "区间充入",
                            value:
                                usage.toppedUp > 0
                                    ? formatAmount(usage.toppedUp, currency)
                                    : "0" + symbolOf(currency),
                        }),
                        react.createElement(TrendStat, {
                            label: "平均消耗速率",
                            value: rateValue,
                            tone: usage.perHour === null ? undefined : rateTone,
                        }),
                        react.createElement(TrendStat, {
                            label: "剩余额度变化",
                            value:
                                usage.start === null
                                    ? "--"
                                    : formatAmount(usage.start, currency) +
                                      " → " +
                                      formatAmount(usage.end, currency),
                        }),
                    ),
                    usage.spanMs > 0
                        ? react.createElement(
                              "p",
                              { className: "bm-trend-note" },
                              "采样点最多保留 1440 条，超出后最旧的采样会被丢弃",
                          )
                        : null,
                ),
            );
        }

        // -----------------------------------------------------------------------
        // Settings page: 设置 → 余额监控
        // -----------------------------------------------------------------------

        /**
         * Trend windows. Used by BOTH the settings-page card and the sidebar
         * dialog's period tabs, so the two can never disagree about what 「近6小时」
         * means. `tab` marks the short day-scale spans the dialog shows first.
         */
        var RANGE_OPTIONS = [
            { id: "1h", label: "近1小时", ms: 3600000, bucketMs: 300000 },
            { id: "6h", label: "近6小时", ms: 21600000, bucketMs: 900000 },
            { id: "24h", label: "近24小时", ms: 86400000, bucketMs: 3600000 },
            { id: "7d", label: "近7天", ms: 604800000, bucketMs: 86400000 },
            { id: "30d", label: "近30天", ms: 2592000000, bucketMs: 86400000 },
            { id: "all", label: "全部", ms: null, bucketMs: 0 },
        ];

        /** Window ids offered as tabs in the sidebar dialog, in tab order. */
        var TREND_TABS = ["1h", "6h", "24h", "7d", "30d", "all"];

        function SwitchRow(props) {
            var checked = !!props.checked;
            return react.createElement(
                "label",
                { className: "bm-row-set" },
                react.createElement(
                    "span",
                    { className: "bm-row-label" },
                    react.createElement(
                        "span",
                        { className: "bm-row-title" },
                        props.label,
                    ),
                    typeof props.hint === "string"
                        ? react.createElement(
                              "span",
                              { className: "bm-row-hint" },
                              props.hint,
                          )
                        : null,
                ),
                react.createElement(
                    "button",
                    {
                        type: "button",
                        role: "switch",
                        "aria-checked": checked,
                        className: "bm-switch" + (checked ? " bm-on" : ""),
                        onClick: function () {
                            props.onChange(!checked);
                        },
                    },
                    react.createElement("span", { className: "bm-knob" }),
                ),
            );
        }

        function NumberRow(props) {
            var value = props.value;
            var min = typeof props.min === "number" ? props.min : 5;
            var max = typeof props.max === "number" ? props.max : 3600;
            var draftState = react.useState(String(value));
            var draft = draftState[0];
            var setDraft = draftState[1];
            react.useEffect(
                function () {
                    setDraft(String(value));
                },
                [value],
            );
            var commit = function () {
                var text = String(draft).trim();
                var n = Number(text);
                if (text.length === 0 || !Number.isFinite(n)) {
                    setDraft(String(value));
                    return;
                }
                var clamped = Math.round(Math.min(max, Math.max(min, n)));
                if (clamped !== value) props.onChange(clamped);
                else setDraft(String(clamped));
            };
            return react.createElement(
                "label",
                { className: "bm-row-set" },
                react.createElement(
                    "span",
                    { className: "bm-row-label" },
                    react.createElement(
                        "span",
                        { className: "bm-row-title" },
                        props.label,
                    ),
                    react.createElement(
                        "span",
                        { className: "bm-row-hint" },
                        props.hint,
                    ),
                ),
                react.createElement("input", {
                    type: "number",
                    min: min,
                    max: max,
                    className: "bm-input",
                    value: draft,
                    onChange: function (e) {
                        setDraft(e.target.value);
                    },
                    onBlur: commit,
                    onKeyDown: function (e) {
                        if (e.key === "Enter") commit();
                    },
                }),
            );
        }

        /**
         * A fractional numeric field (the integer NumberRow rounds, which would
         * turn 0.85 s into 1 s on commit).
         */
        function DecimalRow(props) {
            var value = props.value;
            var min = typeof props.min === "number" ? props.min : 0;
            var max = typeof props.max === "number" ? props.max : 1;
            var step = typeof props.step === "number" ? props.step : 0.05;
            var draftState = react.useState(String(value));
            var draft = draftState[0];
            var setDraft = draftState[1];
            react.useEffect(
                function () {
                    setDraft(String(value));
                },
                [value],
            );
            var commit = function () {
                var text = String(draft).trim();
                var n = Number(text);
                if (text.length === 0 || !Number.isFinite(n)) {
                    setDraft(String(value));
                    return;
                }
                var clamped = Math.min(max, Math.max(min, n));
                var rounded = Number(
                    (Math.round(clamped / step) * step).toFixed(2),
                );
                if (rounded !== value) props.onChange(rounded);
                else setDraft(String(rounded));
            };
            return react.createElement(
                "label",
                { className: "bm-row-set" },
                react.createElement(
                    "span",
                    { className: "bm-row-label" },
                    react.createElement(
                        "span",
                        { className: "bm-row-title" },
                        props.label,
                    ),
                    react.createElement(
                        "span",
                        { className: "bm-row-hint" },
                        props.hint,
                    ),
                ),
                react.createElement("input", {
                    type: "number",
                    min: min,
                    max: max,
                    step: step,
                    className: "bm-input",
                    value: draft,
                    onChange: function (e) {
                        setDraft(e.target.value);
                    },
                    onBlur: commit,
                    onKeyDown: function (e) {
                        if (e.key === "Enter") commit();
                    },
                }),
            );
        }

        /**
         * The balance curve.
         *
         * @param points - `{ t, value }` samples (see {@link bucketPoints}).
         * @param symbol - currency code, for the hover tooltip's amount format.
         * @param width/height - viewBox size; the SVG always fills its container, so
         *                       the dialog can hand it a shorter, wider box than the
         *                       settings card without changing the drawing.
         * @param tFor - `(ms) => string` clock format for the tooltip and the axis
         *               ends (HH:MM on hour-scale windows, MM/DD across days).
         * @param domain - `{ from, to }` x-range to draw over. Defaults to the
         *                 points' own extent; the dialog passes the selected window
         *                 so a 6h chart always spans 6h of axis even while the
         *                 sample history is still filling up.
         */
        function Sparkline(props) {
            var points = props.points;
            var symbol = typeof props.symbol === "string" ? props.symbol : "";
            var width = typeof props.width === "number" ? props.width : 640;
            var height = typeof props.height === "number" ? props.height : 132;
            var tFor = typeof props.tFor === "function" ? props.tFor : fmtDay;
            var hoverState = react.useState(null);
            var hover = hoverState[0];
            var setHover = hoverState[1];
            var boxState = react.useState(null);
            var box = boxState[0];
            var setBox = boxState[1];

            if (points.length === 0) {
                return react.createElement(
                    "div",
                    { className: "bm-chart-empty" },
                    "暂无采样数据，等待下一次刷新…",
                );
            }

            var padLeft = 8;
            var padRight = 8;
            var padTop = 16;
            var padBottom = 16;
            var innerW = width - padLeft - padRight;
            var innerH = height - padTop - padBottom;

            var values = points.map(function (p) {
                return p.value;
            });
            var min = Math.min.apply(null, values);
            var max = Math.max.apply(null, values);
            var span = max - min;
            // A flat line (span 0) is drawn through the middle instead of collapsing.
            var scaleY = function (v) {
                return span === 0
                    ? padTop + innerH / 2
                    : padTop + innerH - ((v - min) / span) * innerH;
            };
            var times = points.map(function (p) {
                return p.t;
            });
            var tMin = Math.min.apply(null, times);
            var tMax = Math.max.apply(null, times);
            var domain =
                props.domain !== null && typeof props.domain === "object"
                    ? props.domain
                    : null;
            if (
                domain !== null &&
                typeof domain.from === "number" &&
                typeof domain.to === "number" &&
                domain.to > domain.from
            ) {
                tMin = domain.from;
                tMax = domain.to;
            }
            var tSpan = tMax - tMin;
            var scaleX = function (t) {
                // A single sample has no span to place it in: pin it to the middle.
                if (tSpan === 0) return padLeft + innerW / 2;
                // A point carried in from before the window clamps to the left edge
                // rather than escaping the viewBox.
                return (
                    padLeft +
                    Math.min(1, Math.max(0, (t - tMin) / tSpan)) * innerW
                );
            };

            var coords = points.map(function (p) {
                return {
                    x: scaleX(p.t),
                    y: scaleY(p.value),
                    t: p.t,
                    value: p.value,
                };
            });
            var line = coords
                .map(function (c, i) {
                    return (
                        (i === 0 ? "M" : "L") +
                        c.x.toFixed(2) +
                        " " +
                        c.y.toFixed(2)
                    );
                })
                .join(" ");
            var area =
                line +
                " L" +
                coords[coords.length - 1].x.toFixed(2) +
                " " +
                (padTop + innerH) +
                " L" +
                coords[0].x.toFixed(2) +
                " " +
                (padTop + innerH) +
                " Z";
            var last = coords[coords.length - 1];

            var onMove = function (event) {
                var rect = event.currentTarget.getBoundingClientRect();
                if (rect.width === 0) return;
                setBox(rect);
                var ratio = (event.clientX - rect.left) / rect.width;
                var x = ratio * width;
                var best = coords[0];
                var bestDistance = Math.abs(best.x - x);
                for (var i = 1; i < coords.length; i++) {
                    var distance = Math.abs(coords[i].x - x);
                    if (distance < bestDistance) {
                        bestDistance = distance;
                        best = coords[i];
                    }
                }
                setHover(best);
            };

            var children = [
                react.createElement(
                    "defs",
                    { key: "defs" },
                    react.createElement(
                        "linearGradient",
                        {
                            id: "bm-spark-fill",
                            x1: "0",
                            y1: "0",
                            x2: "0",
                            y2: "1",
                        },
                        react.createElement("stop", {
                            offset: "0%",
                            stopColor: "currentColor",
                            stopOpacity: "0.28",
                        }),
                        react.createElement("stop", {
                            offset: "100%",
                            stopColor: "currentColor",
                            stopOpacity: "0.02",
                        }),
                    ),
                ),
                react.createElement("path", {
                    key: "area",
                    d: area,
                    fill: "url(#bm-spark-fill)",
                    stroke: "none",
                }),
                react.createElement("path", {
                    key: "line",
                    d: line,
                    fill: "none",
                    stroke: "currentColor",
                    strokeWidth: 1.6,
                    strokeLinejoin: "round",
                    strokeLinecap: "round",
                }),
                react.createElement("circle", {
                    key: "last",
                    cx: last.x.toFixed(2),
                    cy: last.y.toFixed(2),
                    r: 2.6,
                    fill: "currentColor",
                }),
            ];

            if (hover !== null) {
                children.push(
                    react.createElement("line", {
                        key: "cross",
                        x1: hover.x.toFixed(2),
                        y1: padTop,
                        x2: hover.x.toFixed(2),
                        y2: padTop + innerH,
                        stroke: "currentColor",
                        strokeWidth: 1,
                        strokeDasharray: "3 3",
                        opacity: 0.55,
                    }),
                );
                children.push(
                    react.createElement("circle", {
                        key: "dot",
                        cx: hover.x.toFixed(2),
                        cy: hover.y.toFixed(2),
                        r: 3.2,
                        fill: "currentColor",
                    }),
                );
            }

            var tip = null;
            if (hover !== null && box !== null) {
                var leftPx = (hover.x / width) * box.width;
                var flip = leftPx > box.width - 90;
                tip = react.createElement(
                    "div",
                    {
                        className: "bm-hover-tip" + (flip ? " bm-flip" : ""),
                        style: { left: leftPx + "px" },
                    },
                    react.createElement(
                        "span",
                        { className: "bm-hover-time" },
                        tFor(hover.t) + " ",
                    ),
                    react.createElement(
                        "span",
                        { className: "bm-hover-val" },
                        formatAmount(hover.value, symbol),
                    ),
                );
            }

            return react.createElement(
                "div",
                {
                    className: "bm-chart",
                    style: { color: "var(--dsw-alias-state-business-primary)" },
                },
                react.createElement(
                    "svg",
                    {
                        viewBox: "0 0 " + width + " " + height,
                        width: "100%",
                        height: height,
                        onMouseMove: onMove,
                        onMouseLeave: function () {
                            setHover(null);
                            setBox(null);
                        },
                    },
                    children,
                ),
                tip,
                react.createElement(
                    "div",
                    { className: "bm-chart-axis" },
                    react.createElement("span", null, tFor(tMin)),
                    react.createElement("span", null, tFor(tMax)),
                ),
            );
        }

        function MonitorSection() {
            var snap = useMonitor();
            var cfg = snap.config === null ? DEFAULTS : snap.config;
            var display = resolveDisplay(snap);
            var currency = display.currency;
            var rangeState = react.useState("6h");
            var range = rangeState[0];
            var setRange = rangeState[1];
            var spinState = react.useState(0);
            var spin = spinState[0];
            var setSpin = spinState[1];

            react.useEffect(function () {
                // The section may mount before the badge ever ran (settings-first flow).
                // NOTE: no stopLoop() on unmount — the refresh timer is owned by the
                // module, not by this page. Stopping it here killed auto-refresh for
                // the sidebar badge as soon as the settings modal was closed.
                if (MONITOR_STATE.config === null) void loadConfig(true);
                else {
                    startLoop();
                    if (MONITOR_STATE.balances === null)
                        void refreshBalance(false);
                }
                void loadHealth();
            }, []);

            var option =
                RANGE_OPTIONS.find(function (o) {
                    return o.id === range;
                }) || RANGE_OPTIONS[1];
            var since = option.ms === null ? undefined : Date.now() - option.ms;
            var points =
                snap.config !== null && cfg.showTrend !== false
                    ? historyPoints(snap, currency, since)
                    : [];
            var values = points.map(function (p) {
                return p.value;
            });
            var low = values.length > 0 ? Math.min.apply(null, values) : null;
            var high = values.length > 0 ? Math.max.apply(null, values) : null;

            var statusClass =
                snap.error !== null
                    ? " bm-live-err"
                    : snap.lastUpdated !== null
                      ? " bm-live-ok"
                      : "";
            var dotClass =
                snap.error !== null
                    ? "bm-dot-error"
                    : snap.lastUpdated !== null
                      ? "bm-dot-ok"
                      : "";

            // Separate from the badge's `spin`: that one is gated on the balance
            // actually changing ("余额没有变化时刷新图标不动"). This button is the
            // settings page's own explicit refresh action, so it rotates whenever the
            // user presses it — pressing a button and getting no feedback at all
            // would read as broken.
            var manualRefresh = function () {
                setSpin(spin + 1);
                void refreshBalance(true);
            };

            var cards = [];

            // ---- live balance ----
            var curRows = (snap.balances || []).map(function (item) {
                var isPrimary = item.currency === currency;
                return react.createElement(
                    "div",
                    {
                        key: item.currency,
                        className:
                            "bm-cur-row" + (isPrimary ? " bm-cur-on" : ""),
                    },
                    react.createElement(
                        "span",
                        { className: "bm-cur-left" },
                        react.createElement(
                            "span",
                            { className: "bm-cur-code" },
                            item.currency,
                        ),
                        // `is_available` is one account-level flag; show it on the primary row.
                        isPrimary && snap.available === false
                            ? react.createElement(
                                  "span",
                                  { className: "bm-cur-tag" },
                                  "账户不可用",
                              )
                            : null,
                    ),
                    react.createElement(
                        "span",
                        { className: "bm-cur-value" },
                        formatAmount(item.balance, item.currency),
                    ),
                );
            });

            cards.push(
                react.createElement(
                    "div",
                    { className: "bm-card", key: "live" },
                    react.createElement(
                        "div",
                        { className: "bm-card-head" },
                        react.createElement(
                            "span",
                            { className: "bm-card-title" },
                            "当前余额",
                        ),
                        react.createElement(
                            "button",
                            {
                                key: "refresh-" + spin,
                                type: "button",
                                className:
                                    "bm-btn" + (spin > 0 ? " bm-spin" : ""),
                                disabled: snap.fetching,
                                onClick: manualRefresh,
                            },
                            react.createElement(RefreshIcon),
                            "刷新",
                        ),
                    ),
                    react.createElement(
                        "div",
                        { className: "bm-live-main" },
                        react.createElement("span", {
                            className: "bm-live-dot " + dotClass,
                        }),
                        react.createElement(
                            "span",
                            { className: "bm-live-num" },
                            display.value === null
                                ? "--"
                                : // Same symbol placement as the badge, so the two never disagree.
                                  react.createElement(AmountValue, {
                                      value: display.value,
                                      currency: currency,
                                      position: cfg.currencySymbol,
                                      duration:
                                          typeof cfg.rollDuration === "number"
                                              ? cfg.rollDuration
                                              : DEFAULTS.rollDuration,
                                      stagger:
                                          typeof cfg.rollStagger === "number"
                                              ? cfg.rollStagger
                                              : DEFAULTS.rollStagger,
                                  }),
                        ),
                        display.value === null
                            ? null
                            : react.createElement(
                                  "span",
                                  { className: "bm-live-cur" },
                                  currency,
                              ),
                    ),
                    react.createElement(
                        "div",
                        { className: "bm-live-meta" + statusClass },
                        react.createElement(
                            "span",
                            null,
                            snap.error !== null
                                ? snap.error
                                : snap.lastUpdated === null
                                  ? "正在读取…"
                                  : "最后更新 " + fmtTime(snap.lastUpdated),
                        ),
                        snap.spend !== null &&
                            typeof snap.spend[currency] === "number"
                            ? react.createElement(
                                  "span",
                                  null,
                                  "本机累计消费 " +
                                      formatAmount(
                                          snap.spend[currency],
                                          currency,
                                      ),
                              )
                            : null,
                    ),
                    curRows.length > 1
                        ? react.createElement(
                              "div",
                              { className: "bm-cur-list" },
                              curRows,
                          )
                        : null,
                ),
            );

            // ---- trend ----
            if (cfg.showTrend !== false) {
                cards.push(
                    react.createElement(
                        "div",
                        { className: "bm-card", key: "trend" },
                        react.createElement(
                            "div",
                            { className: "bm-card-head" },
                            react.createElement(
                                "span",
                                { className: "bm-card-title" },
                                "余额趋势",
                            ),
                            react.createElement(
                                "span",
                                { className: "bm-range" },
                                RANGE_OPTIONS.map(function (o) {
                                    return react.createElement(
                                        "button",
                                        {
                                            key: o.id,
                                            type: "button",
                                            className:
                                                "bm-range-btn" +
                                                (o.id === range
                                                    ? " bm-on"
                                                    : ""),
                                            onClick: function () {
                                                setRange(o.id);
                                            },
                                        },
                                        o.label,
                                    );
                                }),
                            ),
                        ),
                        react.createElement(Sparkline, {
                            points: points,
                            symbol: currency,
                        }),
                        values.length > 0
                            ? react.createElement(
                                  "div",
                                  { className: "bm-chart-stats" },
                                  react.createElement(
                                      "span",
                                      null,
                                      "最低 " + formatAmount(low, currency),
                                  ),
                                  react.createElement(
                                      "span",
                                      null,
                                      "最高 " + formatAmount(high, currency),
                                  ),
                              )
                            : null,
                    ),
                );
            }

            // ---- parameters ----
            var currencyOptions = ["auto"].concat(
                (snap.balances || []).map(function (b) {
                    return b.currency;
                }),
            );
            cards.push(
                react.createElement(
                    "div",
                    { className: "bm-card", key: "config" },
                    react.createElement(
                        "div",
                        { className: "bm-card-head" },
                        react.createElement(
                            "span",
                            { className: "bm-card-title" },
                            "参数",
                        ),
                        react.createElement(
                            "button",
                            {
                                type: "button",
                                className: "bm-btn",
                                onClick: function () {
                                    if (
                                        typeof window !== "undefined" &&
                                        window.confirm(
                                            "清空余额趋势历史与本机累计消费记录？",
                                        )
                                    )
                                        void resetHistory();
                                },
                            },
                            "清空历史",
                        ),
                    ),
                    snap.configError !== null
                        ? react.createElement(
                              "div",
                              { className: "bm-config-error" },
                              "参数未保存：" + snap.configError,
                          )
                        : null,
                    react.createElement(SwitchRow, {
                        label: "显示侧边栏余额",
                        hint: "关闭后侧边栏不再显示账户余额",
                        checked: cfg.showBadge !== false,
                        onChange: function (v) {
                            void saveConfig({ showBadge: v });
                        },
                    }),
                    react.createElement(SwitchRow, {
                        label: "自动刷新",
                        hint: "定时查询账户余额",
                        checked: cfg.autoRefresh !== false,
                        onChange: function (v) {
                            void saveConfig({ autoRefresh: v });
                        },
                    }),
                    react.createElement(NumberRow, {
                        label: "刷新间隔（秒）",
                        hint: "范围 5–3600 秒",
                        value: cfg.refreshInterval,
                        min: 5,
                        max: 3600,
                        onChange: function (v) {
                            void saveConfig({ refreshInterval: v });
                        },
                    }),
                    react.createElement(DecimalRow, {
                        label: "数字滚动时长（秒）",
                        hint: "余额变化时每位数字滚动的时间，范围 0.3–3 秒",
                        value:
                            typeof cfg.rollDuration === "number"
                                ? cfg.rollDuration
                                : DEFAULTS.rollDuration,
                        min: 0.3,
                        max: 3,
                        step: 0.05,
                        onChange: function (v) {
                            void saveConfig({ rollDuration: v });
                        },
                    }),
                    react.createElement(DecimalRow, {
                        label: "数位滚动间隔（秒）",
                        hint: "各数位错开起步的间隔：从最低位开始依次向左，0 = 同时滚动，范围 0–0.2 秒",
                        value:
                            typeof cfg.rollStagger === "number"
                                ? cfg.rollStagger
                                : DEFAULTS.rollStagger,
                        min: 0,
                        max: 0.2,
                        step: 0.005,
                        onChange: function (v) {
                            void saveConfig({ rollStagger: v });
                        },
                    }),
                    react.createElement(SwitchRow, {
                        label: "显示「高峰 / 低谷」时段标签",
                        hint: "余额文字右侧的小标签：高峰（工作日 9-12、14-18 北京时间）/ 低谷 / 周末全天低谷",
                        checked: cfg.showPhaseTag !== false,
                        onChange: function (v) {
                            void saveConfig({ showPhaseTag: v });
                        },
                    }),
                    react.createElement(SwitchRow, {
                        label: "显示手动刷新按钮",
                        hint: "在侧边栏余额行右侧显示手动刷新箭头",
                        checked: cfg.showRefreshButton !== false,
                        onChange: function (v) {
                            void saveConfig({ showRefreshButton: v });
                        },
                    }),
                    react.createElement(
                        "div",
                        { className: "bm-row-set" },
                        react.createElement(
                            "span",
                            { className: "bm-row-label" },
                            react.createElement(
                                "span",
                                { className: "bm-row-title" },
                                "显示币种",
                            ),
                            react.createElement(
                                "span",
                                { className: "bm-row-hint" },
                                "自动 = 优先 CNY",
                            ),
                        ),
                        react.createElement(
                            "select",
                            {
                                className: "bm-select",
                                value: cfg.displayCurrency,
                                onChange: function (e) {
                                    // An explicit choice here clears the dialog's currency pin, or the
                                    // pinned currency would keep winning and this select would look
                                    // inert (same class of bug as the swallowed rejected patch).
                                    void saveConfig({
                                        displayCurrency: e.target.value,
                                    });
                                    update({ trendCurrency: null });
                                },
                            },
                            currencyOptions.map(function (code) {
                                return react.createElement(
                                    "option",
                                    { key: code, value: code },
                                    code === "auto" ? "自动" : code,
                                );
                            }),
                        ),
                    ),
                    react.createElement(
                        "div",
                        { className: "bm-row-set" },
                        react.createElement(
                            "span",
                            { className: "bm-row-label" },
                            react.createElement(
                                "span",
                                { className: "bm-row-title" },
                                "图标",
                            ),
                            react.createElement(
                                "span",
                                { className: "bm-row-hint" },
                                "余额行左侧的图标，共 " +
                                    ICONS.length +
                                    " 个可选",
                            ),
                        ),
                    ),
                    react.createElement(
                        "div",
                        { className: "bm-icons" },
                        ICONS.map(function (entry) {
                            var on = iconDef(cfg.icon).id === entry.id;
                            return react.createElement(
                                "button",
                                {
                                    key: entry.id,
                                    type: "button",
                                    title: entry.label,
                                    "aria-pressed": on,
                                    className:
                                        "bm-icons-btn" + (on ? " bm-on" : ""),
                                    onClick: function () {
                                        void saveConfig({ icon: entry.id });
                                    },
                                },
                                react.createElement(
                                    "span",
                                    { className: "bm-icons-glyph" },
                                    iconFor(entry.id),
                                ),
                                react.createElement(
                                    "span",
                                    { className: "bm-icons-name" },
                                    entry.label,
                                ),
                            );
                        }),
                    ),
                    react.createElement(
                        "div",
                        { className: "bm-row-set" },
                        react.createElement(
                            "span",
                            { className: "bm-row-label" },
                            react.createElement(
                                "span",
                                { className: "bm-row-title" },
                                "货币符号",
                            ),
                            react.createElement(
                                "span",
                                { className: "bm-row-hint" },
                                "侧边栏余额显示效果",
                            ),
                        ),
                        react.createElement(
                            "span",
                            { className: "bm-seg" },
                            SYMBOL_OPTIONS.map(function (option) {
                                var on =
                                    symbolPosition(cfg.currencySymbol) ===
                                    option.id;
                                return react.createElement(
                                    "button",
                                    {
                                        key: option.id,
                                        type: "button",
                                        title: option.hint,
                                        "aria-pressed": on,
                                        className:
                                            "bm-seg-btn" + (on ? " bm-on" : ""),
                                        onClick: function () {
                                            void saveConfig({
                                                currencySymbol: option.id,
                                            });
                                        },
                                    },
                                    option.label,
                                );
                            }),
                        ),
                    ),
                    react.createElement(SwitchRow, {
                        label: "显示余额趋势",
                        hint: "是否显示弹窗上方的余额趋势曲线图",
                        checked: cfg.showTrend !== false,
                        onChange: function (v) {
                            void saveConfig({ showTrend: v });
                        },
                    }),
                ),
            );

            // ---- diagnostics ----
            var health = snap.health;
            var transport =
                health === null
                    ? "探测中…"
                    : health.transport === "loopback"
                      ? "回环载体（桌面版）"
                      : "宿主 webServer（Web 版）";
            cards.push(
                react.createElement(
                    "div",
                    { className: "bm-card", key: "diag" },
                    react.createElement(
                        "div",
                        { className: "bm-card-head" },
                        react.createElement(
                            "span",
                            { className: "bm-card-title" },
                            "诊断",
                        ),
                        react.createElement(
                            "button",
                            {
                                type: "button",
                                className: "bm-btn",
                                onClick: function () {
                                    void loadHealth();
                                    void refreshBalance(false);
                                },
                            },
                            "重新探测",
                        ),
                    ),
                    react.createElement(
                        "div",
                        {
                            className: "bm-cur-list",
                            style: { borderTop: "none", paddingTop: 0 },
                        },
                        diagRow("传输方式", transport),
                        diagRow(
                            "宿主版本",
                            health !== null &&
                                typeof health.version === "string"
                                ? "v" + health.version
                                : "--",
                        ),
                        diagRow(
                            "宿主 Node",
                            health !== null && typeof health.node === "string"
                                ? health.node
                                : "--",
                        ),
                        diagRow(
                            "请求计数",
                            health !== null &&
                                typeof health.requests === "number"
                                ? String(health.requests)
                                : "--",
                        ),
                        diagRow(
                            "状态文件",
                            health !== null &&
                                typeof health.stateFile === "string"
                                ? health.stateFile
                                : "--",
                        ),
                        diagRow(
                            "最近错误",
                            (health !== null &&
                            typeof health.lastError === "string"
                                ? health.lastError
                                : null) ??
                                snap.error ??
                                "无",
                        ),
                        diagRow("页面传输错误", transportError ?? "无"),
                    ),
                    react.createElement(
                        "div",
                        { className: "bm-diag-note" },
                        "余额数据来自官方接口 https://api.deepseek.com/user/balance，API Key 由宿主 credentials 服务提供",
                    ),
                ),
            );

            return react.createElement(
                "div",
                { className: "bm-section" },
                react.createElement(
                    "div",
                    { className: "bm-head" },
                    react.createElement(
                        "h2",
                        { className: "bm-title" },
                        "余额监控",
                    ),
                ),
                cards,
            );

            function diagRow(label, value) {
                return react.createElement(
                    "div",
                    { className: "bm-cur-row", key: label },
                    react.createElement(
                        "span",
                        { className: "bm-cur-code" },
                        label,
                    ),
                    react.createElement(
                        "span",
                        {
                            className: "bm-cur-value",
                            style: {
                                wordBreak: "break-all",
                                textAlign: "right",
                            },
                        },
                        String(value),
                    ),
                );
            }
        }

        // -----------------------------------------------------------------------
        // Plugin body
        // -----------------------------------------------------------------------

        function apply(ctx) {
            var locale = ctx.get("locale");
            if (locale !== undefined && typeof locale.register === "function") {
                ctx.effect(function () {
                    var disposeZh = locale.register("balance-monitor", {
                        zh: { nav: "余额监控", trigger: "余额" },
                        en: { nav: "Balance monitor", trigger: "Balance" },
                    });
                    return disposeZh;
                }, "balance-monitor: dictionaries");
            }

            // Wait for the slots service instead of giving up on it: cordis keeps
            // this callback until the service appears, whatever the load order.
            ctx.inject(["slots"], function (scoped) {
                var slots = scoped.get("slots");
                if (slots === undefined) return;

                // The sidebar foot renders `sidebar.footer.action` before
                // `sidebar.settings`, so this row lands directly above the Settings
                // button. `order: -1` keeps it above any other footer action.
                //
                // The registered component owns BOTH the row and the dialog: the dialog
                // is a body-portaled Modal, so it costs the footer row no layout, and
                // keeping it here means the open flag decides visibility in one place
                // even while the row itself is hidden (`showBadge: false`).
                slots.inject("sidebar.footer.action", function () {
                    return slots.register(
                        {
                            name: "sidebar.footer.action",
                            id: "balance-monitor",
                            order: -1,
                        },
                        function (props) {
                            var snap = useMonitor();
                            var cfg =
                                snap.config === null ? DEFAULTS : snap.config;
                            return react.createElement(
                                react.Fragment,
                                null,
                                cfg.showBadge === false
                                    ? null
                                    : react.createElement(
                                          BadgeComponent,
                                          props,
                                      ),
                                snap.trendOpen === true
                                    ? react.createElement(TrendDialog, null)
                                    : null,
                            );
                        },
                    );
                });

                slots.inject("settings.section", function () {
                    // The label is lazy, not a resolved string: every shipped section
                    // registers a function so the shell can resolve it on each render.
                    return slots.register(
                        {
                            name: "settings.section",
                            id: "balance-monitor",
                            order: 17,
                            label: function () {
                                return locale !== undefined &&
                                    typeof locale.bind === "function"
                                    ? locale.bind("balance-monitor")("nav")
                                    : "余额监控";
                            },
                        },
                        MonitorSection,
                    );
                });
            });

            // Kick the first read off as soon as the client bundle is live.
            void loadConfig(true);
        }

        exports.apply = apply;
        // Pure helpers exposed for the browser-half tests (test/client-smoke.mjs):
        // they carry the roll-animation rules, which are otherwise DOM-bound.
        exports.rollDirectionsFor = rollDirectionsFor;
        exports.mapDirections = mapDirections;
        exports.rollDelay = rollDelay;
        exports.formatAmount = formatAmount;
        exports.amountDigits = amountDigits;
        exports.amountSymbol = amountSymbol;
        exports.resolveDisplay = resolveDisplay;
        // Trend-window math, likewise DOM-free and covered by the same test.
        exports.periodUsage = periodUsage;
        exports.bucketPoints = bucketPoints;
        exports.historyWindowPoints = historyWindowPoints;
        return module.exports;
    },
});
