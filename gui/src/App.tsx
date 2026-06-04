import "./App.css";
import { useState } from "react";
import { AppSidebar, type ViewId } from "./components/AppSidebar";
import { Chat } from "./components/Chat";

function App() {
  const [view, setView] = useState<ViewId>("chat");

  return (
    <div className="app-shell">
      <AppSidebar active={view} onSelect={setView} />
      <main className="app-main">{view === "chat" ? <Chat /> : null}</main>
    </div>
  );
}

export default App;
