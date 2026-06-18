import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Route, Switch } from "wouter";
import Home from "@/pages/home";
import VideoTemplate from "@/components/video/VideoTemplate";
import NotFound from "@/pages/not-found";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: false,
    },
  },
});

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Switch>
        <Route path="/" component={Home} />
        <Route path="/video" component={VideoTemplate} />
        <Route component={NotFound} />
      </Switch>
    </QueryClientProvider>
  );
}

export default App;
