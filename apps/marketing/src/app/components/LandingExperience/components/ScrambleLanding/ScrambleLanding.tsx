"use client";

import { animate, scrambleText } from "animejs";
import { motion, useReducedMotion, type Variants } from "framer-motion";
import { useEffect, useRef } from "react";
import {
	HERO_BRAND_WORDMARK,
	HERO_LLM_TERM,
	HERO_RUNTIME_TERM,
	HERO_SUB_AGENT_CYCLE_WORDS,
	HERO_SUB_LINE_ONE,
	HERO_SUB_LINE_TWO_LEAD,
	HERO_SUB_TAIL,
	HERO_WORKTREE_TERM,
	LANDING_HEADLINE,
} from "../../constants";
import { AnimatedTextCycle } from "../AnimatedTextCycle";
import { OrchestrationField } from "../OrchestrationField";
import {
	FIELD_HINT_LEAD,
	FIELD_HINT_TAIL,
} from "../OrchestrationField/constants";
import { HeroDownloadCta } from "./components/HeroDownloadCta";
import { HeroStackLine } from "./components/HeroStackLine";
import { Term } from "./components/Term";

/**
 * Scramble-text landing document, ported from Julian Garnier's anime.js v4
 * "Scramble Text playground" (codepen gbLOvrw) into Rox branding, then upgraded
 * for a premium feel:
 *
 *  - **Scroll-reveal scramble**: each line scrambles into place as it enters the
 *    viewport (IntersectionObserver one-shot), so the document "types" itself as
 *    you scroll instead of all at once on mount.
 *  - **Living background**: the brand radial glow slowly breathes via animated
 *    CSS custom properties.
 *  - **SVG dividers**: hairline rules between sections draw themselves in on
 *    scroll.
 *
 * Real copy is server-rendered (SEO / no-JS); anime.js only scrambles then
 * restores it. Hovering any line re-scrambles it. Everything is scoped to the
 * container ref and skipped entirely under `prefers-reduced-motion`.
 */
/**
 * Staggered scroll-reveal for the 4 numbered hero features (01–04). Adapted from
 * the ravikatiyar / 21st.dev "feature-highlight" reference: the container fades
 * its children in one-by-one (staggerChildren); each line fades + slides up with
 * a spring. Reduced-motion users get the static rendering (see `reduced` below).
 */
const hintsContainerVariants: Variants = {
	hidden: { opacity: 0 },
	visible: { opacity: 1, transition: { staggerChildren: 0.2 } },
};

const hintItemVariants: Variants = {
	hidden: { opacity: 0, y: 20 },
	visible: {
		opacity: 1,
		y: 0,
		transition: { type: "spring", stiffness: 100, damping: 15 },
	},
};

export function ScrambleLanding() {
	const containerRef = useRef<HTMLElement>(null);
	const prefersReducedMotion = useReducedMotion();
	// Reduced motion: render hints fully visible, no stagger/slide.
	const hintsInitial = prefersReducedMotion ? "visible" : "hidden";
	const hintItemVariant = prefersReducedMotion ? undefined : hintItemVariants;
	const webUrl = process.env.NEXT_PUBLIC_WEB_URL ?? "http://localhost:3000";
	const animationsRef = useRef<
		Array<{ cancel?: () => void; revert?: () => void }>
	>([]);

	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;

		// Respect reduced-motion: leave the (already rendered) text static.
		if (
			typeof window !== "undefined" &&
			window.matchMedia("(prefers-reduced-motion: reduce)").matches
		) {
			return;
		}

		const cleanups: Array<() => void> = [];
		const trackAnimation = <
			T extends { cancel?: () => void; revert?: () => void },
		>(
			animation: T,
		) => {
			animationsRef.current.push(animation);
			return animation;
		};
		const cleanupAnimations = () => {
			for (const animation of animationsRef.current) {
				animation.cancel?.();
				animation.revert?.();
			}
			animationsRef.current = [];
		};

		// ── C. Living background: slow breathing of the brand glow ──────────
		trackAnimation(
			animate(container, {
				"--rox-glow-a": [0.1, 0.16],
				"--rox-glow-y": ["-8%", "-3%"],
				loop: true,
				alternate: true,
				duration: 6000,
				ease: "inOut(2)",
			}),
		);

		// ── A. Scroll-reveal scramble (one-shot per line) + hover re-scramble
		const scrambleEls = Array.from(
			container.querySelectorAll<HTMLElement>(".rox-scramble"),
		);

		const revealScramble = (element: HTMLElement) => {
			trackAnimation(
				animate(element, {
					innerHTML: scrambleText({
						override: "",
						duration: 750,
						settleDuration: 250,
						perturbation: 0.2,
						cursor: "░▒▓█",
					}),
				}),
			);
		};

		const revealObserver = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (entry.isIntersecting) {
						revealScramble(entry.target as HTMLElement);
						revealObserver.unobserve(entry.target);
					}
				}
			},
			{ rootMargin: "0px 0px -12% 0px", threshold: 0.15 },
		);

		for (const element of scrambleEls) {
			revealObserver.observe(element);
			const replay = () => {
				trackAnimation(
					animate(element, { innerHTML: scrambleText({ duration: 500 }) }),
				);
			};
			element.addEventListener("pointerenter", replay);
			element.addEventListener("pointerdown", replay);
			cleanups.push(() => {
				element.removeEventListener("pointerenter", replay);
				element.removeEventListener("pointerdown", replay);
			});
		}
		cleanups.push(() => revealObserver.disconnect());

		return () => {
			for (const cleanup of cleanups) cleanup();
			cleanupAnimations();
		};
	}, []);

	return (
		<main ref={containerRef} className="rox-anime rox-landing">
			<a className="rox-landing__cabinet-link" href={`${webUrl}/agents`}>
				Личный кабинет
			</a>
			<OrchestrationField />

			<section className="rox-hero">
				<div className="rox-hero__inner">
					<div className="rox-landing__brand">
						<span className="rox-scramble">{HERO_BRAND_WORDMARK}</span>
					</div>

					<h1 className="rox-scramble rox-hero__headline">
						{LANDING_HEADLINE}
					</h1>

					<div className="rox-hero__sub">
						<span className="rox-hero__sub-line">{HERO_SUB_LINE_ONE}</span>
						<span className="rox-hero__sub-line">
							{HERO_SUB_LINE_TWO_LEAD}{" "}
							<AnimatedTextCycle
								words={HERO_SUB_AGENT_CYCLE_WORDS}
								interval={1000}
								fast
								className="rox-hero__sub-cycle"
							/>{" "}
							{HERO_SUB_TAIL}
						</span>
					</div>

					<motion.ul
						className="rox-hero__hints"
						aria-label="Фишки Rox"
						variants={hintsContainerVariants}
						initial={hintsInitial}
						whileInView="visible"
						viewport={{ once: true, amount: 0.35 }}
					>
						<motion.li className="rox-hero__hint" variants={hintItemVariant}>
							<span className="rox-hero__hint-body">
								{FIELD_HINT_LEAD}
								<span className="rox-hero__line-break">{FIELD_HINT_TAIL}</span>
							</span>
						</motion.li>

						<motion.li className="rox-hero__hint" variants={hintItemVariant}>
							<span className="rox-hero__hint-body">
								Агенты не мешают друг другу: каждый решает вопросики в своей{" "}
								<Term {...HERO_WORKTREE_TERM} /> —
								<span className="rox-hero__line-break">
									без ошибок, пересечений и конфликтов
								</span>
							</span>
						</motion.li>

						<motion.li className="rox-hero__hint" variants={hintItemVariant}>
							<span className="rox-hero__hint-body">
								Выдаем под твоего агента <Term {...HERO_RUNTIME_TERM} /> 24/7 с
								безлимитным доступом к <Term {...HERO_LLM_TERM} /> — всем,
								бесплатно, навсегда
							</span>
						</motion.li>

						<motion.li className="rox-hero__hint" variants={hintItemVariant}>
							<span className="rox-hero__hint-body">
								<HeroStackLine />
							</span>
						</motion.li>
					</motion.ul>

					<HeroDownloadCta />
				</div>
			</section>
		</main>
	);
}
