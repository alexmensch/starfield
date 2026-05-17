# Contributing to Stellata

Thanks for your interest. This document covers what kinds of
contributions are welcome, how to file a useful issue, and the
licensing posture for the project.

## TL;DR

- **Issues: yes, please.** Bug reports and enhancement suggestions
  are very much appreciated.
- **Pull requests: not currently accepted from outside contributors.**
  GitHub's "Collaborators only" PR setting is enabled, so the PR
  button is hidden for non-collaborators. If you have a fix or a
  patch in mind, file an issue. Code snippets and proposed patches
  inside an issue are welcome (see below).

## Why no external PRs?

Stellata is a solo, design-led project. The code is small enough,
and the visual / physical-modelling decisions interlock enough, that
reviewing and integrating external patches takes longer than just
implementing the fix myself once the problem is well-described. The
no-PR policy keeps expectations clear on both sides: it's not
that contributions aren't valued, it's that the bottleneck is
design alignment.

This may change as the project grows. The current setting is
deliberate and revisited periodically.

## Filing a bug report

Use the **Bug report** template under
[New issue](https://github.com/alexmensch/stellata/issues/new/choose).
The single most useful thing you can include is a **Stellata URL**
of the view where you saw the bug — every setting and the camera
pose are packed into the `?v=…` query parameter at the top of your
address bar, so a copy-paste lets me reproduce exactly what you saw.

Beyond the URL, what matters most is:

- **What didn't work** — what you saw or what went wrong.
- **What you expected** — even if obvious to you, it isn't always
  obvious from the description of the failure.

Optional but welcome:

- **A proposed fix or code snippet.** If you've already dug into the
  cause and have an idea, please share it in the issue body, I'd
  much rather read your analysis than guess.
- Browser + OS, especially for rendering, gesture, or layout bugs.
- Console errors, if any.

## Requesting an enhancement

Use the **Enhancement** template under
[New issue](https://github.com/alexmensch/stellata/issues/new/choose).
For enhancement requests, the more concrete the better:

- **Exactly what you want.** "Add support for X" is harder to act on
  than "When viewing Y, show Z by doing W". A short worked example
  of the desired behaviour goes a long way.
- **What data set or source you're proposing**, if the feature
  involves new astronomical data. Stellata's data-fidelity
  principle (see [SCIENCE.md](../SCIENCE.md)) means every new
  object class needs a published, observational source. Please
  identify the catalogue, paper, or DOI you have in mind.
- **Why it would be valuable.** This isn't a gate, but it helps
  prioritise.

## Licensing

The code in this repository is AGPL-3.0-only (see [`LICENSE`](../LICENSE)).
The current contribution posture is:

- **Inbound = outbound under AGPL-3.0-or-later.** If you include
  code in an issue (a proposed patch, a snippet, a worked example),
  you license that code under AGPL-3.0-or-later, per [GitHub's
  Terms of Service section D.6](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service#6-contributions-under-repository-license).
- **Provenance.** Please don't paste code you don't have the right
  to license. Code copied from a non-AGPL-compatible source, or
  from your employer's codebase without permission, can't be
  accepted into the project even via an issue paste.
- **Future relicensing.** The maintainer reserves the right to
  introduce a Contributor License Agreement (CLA) at a later date
  if relicensing or dual-licensing the project becomes relevant. If
  that happens, contributors will be asked to sign at that point;
  the policy will not be applied retroactively to existing
  contributions.

## Code of conduct

Be civil and assume good faith. Personal attacks, harassment, and
bad-faith argumentation in issues or comments will get the issue
locked and the author blocked without warning.

## Questions that aren't bugs or enhancements

General questions ("how does X work?", "why was Y modelled this way?")
are fine to file as issues — please label them `question` if you can.
