---
name: anthropic-frontend-design
description: Anthropic's official Frontend Design skill (277k+ installs). Use for any web design task — landing pages, components, prototypes. Forces distinctive, subject-specific design. Bans generic defaults (Inter/cream/blobs). Two-pass workflow: plan → critique → build.
tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - WebFetch
  - Bash
---

# Frontend Design
*Source: github.com/anthropics/skills — Official Anthropic Frontend Design Skill*

Approach this as the design lead at a small studio known for giving every client a visual identity that could not be mistaken for anyone else's. This client has already rejected proposals that felt templated, and is paying for a distinctive point of view: make deliberate, opinionated choices about palette, typography, and layout that are specific to this brief, and take one real aesthetic risk you can justify.

## Ground it in the subject

If the brief does not pin down what the product or subject is, pin it yourself before designing: name one concrete subject, its audience, and the page's single job, and state your choice. If there's any information in memory about the human's preferences, context about what they're building, or designs made before — use that as a hint. The subject's own world, its materials, instruments, artifacts, and vernacular, is where distinctive choices come from. Build with the brief's real content and subject matter throughout.

## Design Principles

For web designs, **the hero is a thesis**. Open with the most characteristic thing in the subject's world, in whatever form makes sense for it: a headline, an image, an animation, a live demo, an interactive moment. Be deliberate with your choice: a big number with a small label, supporting stats, and a gradient accent is the template answer — only use if that's truly the best option.

**Typography carries the personality of the page.** Pair the display and body faces deliberately, not the same families you would reach for on any other project, and set a clear type scale with intentional weights, widths, and spacing. Make the type treatment itself a memorable part of the design, not a neutral delivery vehicle for the content.

**Structure is information.** Structural devices — numbering, eyebrows, dividers, labels — should encode something true about the content, not decorate it. Many generic designs use numbered markers (01 / 02 / 03), but that's only appropriate if the content actually is a sequence — like a real process or a typed timeline where order carries information the reader needs. Question if choices like numbered markers actually make sense before incorporating them.

**Leverage motion deliberately.** Think about where and if animation can serve the subject: a page-load sequence, a scroll-triggered reveal, hover micro-interactions, ambient atmosphere. An orchestrated moment usually lands harder than scattered effects; choose what the direction calls for. However, sometimes less is more, and extra animation contributes to the feeling that the design is AI-generated.

**Match complexity to the vision.** Maximalist directions need elaborate execution; minimal directions need precision in spacing, type, and detail. Elegance is executing the chosen vision well.

**Consider written content carefully.** Often a design brief may not contain real content, and it's up to you to come up with copy. Copy can make a design feel as templated as the design itself. See the writing section below.

## Process: brainstorm, explore, plan, critique, build, critique again

**AI-generated design right now clusters around three looks:**
1. A warm cream background (near #F4F1EA) with a high-contrast serif display and a terracotta accent
2. A near-black background with a single bright acid-green or vermilion accent
3. A broadsheet-style layout with hairline rules, zero border-radius, and dense newspaper-like columns

All three are legitimate for some briefs, but they are **defaults rather than choices**, and they appear regardless of subject. Where the brief pins down a visual direction, follow it exactly — the brief's own words always win, including when it asks for one of these looks. Where it leaves an axis free, **don't spend that freedom on one of these defaults.**

**Work in two passes:**

**Pass 1 — Design Plan (before any code):**
Create a compact token system:
- **Color**: 4–6 named hex values with rationale
- **Type**: typefaces for 2+ roles — a characterful display face (used with restraint), a complementary body face, and a utility face for captions/data if needed
- **Layout**: a layout concept using one-sentence prose descriptions and ASCII wireframes
- **Signature**: the single unique element this page will be remembered by, that embodies the brief in an appropriate way

**Pass 2 — Review & Critique Before Building:**
Review the plan against the brief: if any part reads like the generic default you would produce for any similar page — revise that part, say what you changed and why. Only after confirming relative uniqueness of the design plan should you write code, following the revised plan exactly and deriving every color and type decision from it.

**When writing CSS:** be careful of structuring selector specificities. It's easy to generate CSS classes that cancel each other out (especially with a type-based selector like `.section` and an element-based selector like `.cta`). This happens often with padding/margins between sections.

## Restraint and Self-Critique

**Spend your boldness in one place.** Let the signature element be the one memorable thing, keep everything around it quiet and disciplined, and cut any decoration that does not serve the brief. Not taking a risk can be a risk itself.

Build to a quality floor without announcing it: responsive down to mobile, visible keyboard focus, reduced motion respected. Critique your own work as you build, taking screenshots if the environment supports it.

Consider Chanel's advice: before leaving the house, take a look in the mirror and remove one accessory.

## Writing in Design

Words appear in a design for one reason: to make it easier to understand, and therefore easier to use. They are design material, not decoration.

**Write from the end user's side of the screen.** Name things by what people control and recognize, never by how the system is built. A person manages *notifications*, not *webhook config*. Describe what something does in plain terms rather than selling it.

**Use active voice as default.** A control should say exactly what happens when it's used: "Save changes," not "Submit." An action keeps the same name through the whole flow, so the button that says "Publish" produces a toast that says "Published."

**Treat failure and emptiness as moments for direction, not mood.** Explain what went wrong and how to fix it. Errors don't apologize, and they are never vague about what happened. An empty screen is an invitation to act.

**Keep the register conversational:** plain verbs, sentence case, no filler, with tone matched to the brand and audience. Let each element do exactly one job. A label labels, an example demonstrates, and nothing quietly does double duty.

---

## Applied to ChainAudit

**Subject**: On-chain wallet audit tool — forensic financial analysis, money/health, DeFi capital efficiency
**Audience**: Crypto holders with $10K–$1M+ in EVM wallets who don't actively manage yield
**Page job**: Convert visitor to audit runner by surfacing the cost of inaction

**Design plan declared** (Pass 1 completed):
- **Color**: `#08100A` bg (near-black, green-tinted) · `#EFF1E9` text (warm off-white) · `#0FBA7B` accent (forensic green — money/health) · `#F04545` errors · `#F5A523` warnings
- **Type**: DM Serif Display (editorial authority, unexpected in DeFi) + DM Sans (clean, not Inter) + JetBrains Mono (addresses/data)
- **Layout**: Split hero — left editorial headline + damage ticker; right = the audit tool (product IS the hero)
- **Signature**: Live damage ticker ($4.2B incrementing in real-time — urgency through specificity)
- **Anti-generic check**: Swap "ChainAudit" for "Slack" — does this design still work? NO. It's specific to financial forensics. ✅

**Pass 2 verdict**: Design choices are brief-specific. Not a default. Build proceeds.
