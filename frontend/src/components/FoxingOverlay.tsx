import { useEffect, useRef, useMemo } from 'react';

interface FoxingSpot {
    x: number;
    y: number;
    size: number;
    opacity: number;
    blur: number;
}

export function FoxingOverlay() {
    const canvasRef = useRef<HTMLCanvasElement>(null);

    const spots = useMemo(() => {
        const generated: FoxingSpot[] = [];

        for (let i = 0; i < 6; i++) {
            generated.push({
                x: Math.random() * 100,
                y: Math.random() * 6,
                size: 4 + Math.random() * 10,
                opacity: 0.12 + Math.random() * 0.15,
                blur: 5 + Math.random() * 10,
            });
        }

        for (let i = 0; i < 6; i++) {
            generated.push({
                x: Math.random() * 100,
                y: 94 + Math.random() * 6,
                size: 4 + Math.random() * 10,
                opacity: 0.12 + Math.random() * 0.15,
                blur: 5 + Math.random() * 10,
            });
        }

        for (let i = 0; i < 5; i++) {
            generated.push({
                x: Math.random() * 5,
                y: 10 + Math.random() * 80,
                size: 4 + Math.random() * 8,
                opacity: 0.12 + Math.random() * 0.18,
                blur: 5 + Math.random() * 8,
            });
        }

        for (let i = 0; i < 5; i++) {
            generated.push({
                x: 95 + Math.random() * 5,
                y: 10 + Math.random() * 80,
                size: 4 + Math.random() * 8,
                opacity: 0.12 + Math.random() * 0.18,
                blur: 5 + Math.random() * 8,
            });
        }

        const corners = [
            { x: 0, y: 0 },
            { x: 100, y: 0 },
            { x: 0, y: 100 },
            { x: 100, y: 100 },
        ];

        corners.forEach(corner => {
            for (let i = 0; i < 3; i++) {
                generated.push({
                    x: corner.x + (Math.random() - 0.5) * 12,
                    y: corner.y + (Math.random() - 0.5) * 12,
                    size: 10 + Math.random() * 18,
                    opacity: 0.15 + Math.random() * 0.2,
                    blur: 8 + Math.random() * 15,
                });
            }
        });

        return generated;
    }, []);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const updateCanvas = () => {
            const ctx = canvas.getContext('2d');
            if (!ctx) return;

            canvas.width = window.innerWidth;
            canvas.height = window.innerHeight;

            ctx.clearRect(0, 0, canvas.width, canvas.height);

            const vignetteGradient = ctx.createRadialGradient(
                canvas.width / 2,
                canvas.height / 2,
                Math.min(canvas.width, canvas.height) * 0.2,
                canvas.width / 2,
                canvas.height / 2,
                Math.max(canvas.width, canvas.height) * 0.8
            );
            vignetteGradient.addColorStop(0, 'rgba(139, 90, 43, 0)');
            vignetteGradient.addColorStop(0.5, 'rgba(139, 90, 43, 0.05)');
            vignetteGradient.addColorStop(0.8, 'rgba(101, 67, 33, 0.15)');
            vignetteGradient.addColorStop(1, 'rgba(80, 50, 25, 0.3)');

            ctx.fillStyle = vignetteGradient;
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            spots.forEach(spot => {
                const x = (spot.x / 100) * canvas.width;
                const y = (spot.y / 100) * canvas.height;
                const radius = spot.size * Math.min(canvas.width, canvas.height) / 100;

                ctx.save();
                ctx.filter = `blur(${spot.blur}px)`;

                const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
                gradient.addColorStop(0, `rgba(92, 64, 51, ${spot.opacity})`);
                gradient.addColorStop(0.4, `rgba(101, 67, 33, ${spot.opacity * 0.6})`);
                gradient.addColorStop(1, 'rgba(139, 90, 43, 0)');

                ctx.fillStyle = gradient;
                ctx.beginPath();
                ctx.arc(x, y, radius, 0, Math.PI * 2);
                ctx.fill();
                ctx.restore();
            });
        };

        updateCanvas();
        window.addEventListener('resize', updateCanvas);
        return () => window.removeEventListener('resize', updateCanvas);
    }, [spots]);

    return (
        <canvas
            ref={canvasRef}
            className="fixed inset-0 pointer-events-none"
            style={{ zIndex: 9999 }}
            aria-hidden="true"
        />
    );
}
