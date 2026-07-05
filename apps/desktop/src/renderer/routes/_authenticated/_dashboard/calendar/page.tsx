import { createFileRoute } from "@tanstack/react-router";
import { CalendarView } from "renderer/screens/suite/CalendarView";
import {
	type CalendarSearch,
	calendarSearchSchema,
} from "renderer/screens/suite/CalendarView/utils/searchParams";

export const Route = createFileRoute("/_authenticated/_dashboard/calendar/")({
	component: CalendarPage,
	// #538: persist view/anchor/calendars in the URL so the Calendar's navigation
	// survives reload + the router Back button. `validateSearch` runs the zod
	// schema, which defaults/repairs invalid params instead of throwing; the
	// params stay optional so a plain `<Link to="/calendar">` is still valid.
	validateSearch: (search): CalendarSearch =>
		calendarSearchSchema.parse(search),
});

function CalendarPage() {
	return <CalendarView />;
}
