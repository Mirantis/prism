import "./App.css";
import { useState } from "react";
import { AppSidebar, type ViewId } from "./components/AppSidebar";
import { Overview } from "./components/Overview";
import { Chat } from "./components/Chat";
import { Channels } from "./components/Channels";
import { ScheduledTasks } from "./components/ScheduledTasks";
import { Profile } from "./components/Profile";

function App() {
  const [view, setView] = useState<ViewId>("overview");

  return (
    <div className="app-shell">
      <AppSidebar active={view} onSelect={setView} />
      <main className="app-main">
        {view === "overview" ? <Overview onNavigate={setView} /> : null}
        {view === "chat" ? <Chat /> : null}
        {view === "channels" ? <Channels /> : null}
        {view === "cron" ? <ScheduledTasks /> : null}
        {view === "profile" ? <Profile /> : null}
      </main>
    </div>
  );
}

export default App;
