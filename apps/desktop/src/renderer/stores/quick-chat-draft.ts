import { create } from "zustand";

type QuickChatDraftState = {
	prompt: string | null;
	stagePrompt: (prompt: string) => void;
	consumePrompt: () => string | null;
};

export const useQuickChatDraftStore = create<QuickChatDraftState>(
	(set, get) => ({
		prompt: null,
		stagePrompt: (prompt) => set({ prompt }),
		consumePrompt: () => {
			const { prompt } = get();
			if (prompt === null) return null;
			set({ prompt: null });
			return prompt;
		},
	}),
);
