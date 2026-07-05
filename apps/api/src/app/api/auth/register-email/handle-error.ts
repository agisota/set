export function getHandleErrorMessage(error: string | undefined): string {
	switch (error) {
		case "too_short":
			return "Никнейм должен быть не короче 4 символов.";
		case "too_long":
			return "Никнейм должен быть не длиннее 16 символов.";
		case "invalid_chars":
			return "Никнейм может содержать только латиницу, цифры и подчеркивание.";
		case "reserved":
			return "Этот никнейм нельзя использовать.";
		default:
			return "Некорректный никнейм.";
	}
}
