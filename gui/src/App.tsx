import "./App.css";
import { useState } from "react";
import { AppSidebar, type ViewId } from "./components/AppSidebar";
import { Chat } from "./components/Chat";
import { Overview } from "./components/Overview";

function App() {
  const [view, setView] = useState<ViewId>("overview");

  return (
    <div className="app-shell">
      <AppSidebar active={view} onSelect={setView} />
      <main className="app-main">
        {view === "overview" ? <Overview onNavigate={setView} /> : null}
        {view === "chat" ? <Chat /> : null}
      </main>
    </div>
  );
}

export default App;
