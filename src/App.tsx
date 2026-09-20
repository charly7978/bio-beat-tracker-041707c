import React from "react";
import { BrowserRouter as Router, Routes, Route } from "react-router-dom";
import { ToastProvider, ToastViewport } from "@/components/ui/toast";
import {
  RootErrorBoundary,
  SignalProcessingErrorBoundary,
  CameraErrorBoundary,
  VitalSignsErrorBoundary,
  NetworkErrorBoundary,
} from "@/components/error-boundaries";
import Index from "./pages/Index";
import NotFound from "./pages/NotFound";

const App = () => {
  return (
    <RootErrorBoundary>
      <NetworkErrorBoundary>
        <ToastProvider>
          <Router>
            <Routes>
              <Route 
                path="/" 
                element={
                  <SignalProcessingErrorBoundary>
                    <CameraErrorBoundary>
                      <VitalSignsErrorBoundary>
                        <Index />
                      </VitalSignsErrorBoundary>
                    </CameraErrorBoundary>
                  </SignalProcessingErrorBoundary>
                } 
              />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </Router>
          <ToastViewport />
        </ToastProvider>
      </NetworkErrorBoundary>
    </RootErrorBoundary>
  );
};

export default App;
