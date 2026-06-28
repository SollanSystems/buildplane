// @jsxRuntime automatic
// @jsxImportSource react
import { useEffect, useState } from "react";
import { Inbox } from "./Inbox";
import { Inspector } from "./Inspector";

type Route = "runs" | "inbox";

function routeFromHash(): Route {
	return window.location.hash === "#/inbox" ? "inbox" : "runs";
}

export function App() {
	const [route, setRoute] = useState<Route>(routeFromHash());

	useEffect(() => {
		const onHashChange = () => setRoute(routeFromHash());
		window.addEventListener("hashchange", onHashChange);
		return () => window.removeEventListener("hashchange", onHashChange);
	}, []);

	const navigate = (next: Route) => {
		window.location.hash = next === "inbox" ? "#/inbox" : "#/runs";
		setRoute(next);
	};

	return (
		<div className="app">
			<nav className="app-nav">
				<button
					type="button"
					data-testid="nav-runs"
					aria-current={route === "runs"}
					onClick={() => navigate("runs")}
				>
					Runs
				</button>
				<button
					type="button"
					data-testid="nav-inbox"
					aria-current={route === "inbox"}
					onClick={() => navigate("inbox")}
				>
					Inbox
				</button>
			</nav>
			<main className="app-main">
				{route === "inbox" ? <Inbox /> : <Inspector />}
			</main>
		</div>
	);
}
