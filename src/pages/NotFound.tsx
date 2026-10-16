import { Link, useLocation } from "react-router-dom";
import { useEffect } from "react";
import { createLogger } from "@/utils/logger";

const log = createLogger('NotFound');

const NotFound = () => {
  const location = useLocation();

  useEffect(() => {
    log.warn(
      "Error 404: ruta inexistente solicitada:",
      location.pathname
    );
  }, [location.pathname]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-black">
      <div className="text-center">
        <h1 className="text-4xl font-bold mb-4 text-white">404</h1>
        <p className="text-xl text-zinc-400 mb-4">Página no encontrada</p>
        <Link to="/" className="text-emerald-400 hover:text-emerald-300 underline">
          Volver al inicio
        </Link>
      </div>
    </div>
  );
};

export default NotFound;
