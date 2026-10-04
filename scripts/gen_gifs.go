package main

import (
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/gif"
	"os"
	"path/filepath"
)

type GifDef struct {
	Filename string
	Color1   color.RGBA
	Color2   color.RGBA
}

var gifs = []GifDef{
	{Filename: "excited-happy.gif", Color1: color.RGBA{255, 180, 0, 255}, Color2: color.RGBA{255, 100, 0, 255}},
	{Filename: "laughing-lol.gif", Color1: color.RGBA{255, 215, 0, 255}, Color2: color.RGBA{255, 140, 0, 255}},
	{Filename: "dance-party.gif", Color1: color.RGBA{138, 43, 226, 255}, Color2: color.RGBA{255, 20, 147, 255}},
	{Filename: "facepalm-star-trek.gif", Color1: color.RGBA{70, 130, 180, 255}, Color2: color.RGBA{25, 25, 112, 255}},
	{Filename: "applause-clapping.gif", Color1: color.RGBA{60, 179, 113, 255}, Color2: color.RGBA{46, 139, 87, 255}},
	{Filename: "sad-crying.gif", Color1: color.RGBA{100, 149, 237, 255}, Color2: color.RGBA{65, 105, 225, 255}},
	{Filename: "thumbs-up-good.gif", Color1: color.RGBA{50, 205, 50, 255}, Color2: color.RGBA{34, 139, 34, 255}},
	{Filename: "party-confetti.gif", Color1: color.RGBA{255, 105, 180, 255}, Color2: color.RGBA{147, 112, 219, 255}},
	{Filename: "cat-cute.gif", Color1: color.RGBA{255, 160, 122, 255}, Color2: color.RGBA{250, 128, 114, 255}},
	{Filename: "shocked-surprised.gif", Color1: color.RGBA{255, 69, 0, 255}, Color2: color.RGBA{255, 140, 0, 255}},
	{Filename: "dog-confused.gif", Color1: color.RGBA{210, 180, 140, 255}, Color2: color.RGBA{139, 69, 19, 255}},
	{Filename: "popcorn-eating.gif", Color1: color.RGBA{240, 230, 140, 255}, Color2: color.RGBA{218, 165, 32, 255}},
}

func main() {
	outDir := filepath.Join("client", "public", "gifs")
	if err := os.MkdirAll(outDir, 0755); err != nil {
		panic(err)
	}

	w, h := 320, 240

	for _, g := range gifs {
		var palette color.Palette = []color.Color{
			color.RGBA{0, 0, 0, 255},
			g.Color1,
			g.Color2,
			color.RGBA{255, 255, 255, 255},
			color.RGBA{30, 30, 30, 255},
		}

		anim := &gif.GIF{
			LoopCount: 0,
		}

		numFrames := 8
		for f := 0; f < numFrames; f++ {
			img := image.NewPaletted(image.Rect(0, 0, w, h), palette)

			// Fill background
			bgCol := uint8(1)
			if f%2 == 1 {
				bgCol = 2
			}
			draw.Draw(img, img.Bounds(), &image.Uniform{palette[bgCol]}, image.Point{}, draw.Src)

			// Draw dark inner card
			cardRect := image.Rect(20, 20, w-20, h-20)
			draw.Draw(img, cardRect, &image.Uniform{palette[4]}, image.Point{}, draw.Src)

			// Draw moving animated indicator bar/circle
			cx := 40 + (f * (w - 80) / numFrames)
			cy := h / 2
			r := 18
			for y := cy - r; y <= cy+r; y++ {
				for x := cx - r; x <= cx+r; x++ {
					if (x-cx)*(x-cx)+(y-cy)*(y-cy) <= r*r {
						img.SetColorIndex(x, y, 3)
					}
				}
			}

			// Add small animated pulse
			pulseR := 6 + (f % 4 * 3)
			pcx := w / 2
			pcy := h/2 + 40
			for y := pcy - pulseR; y <= pcy+pulseR; y++ {
				for x := pcx - pulseR; x <= pcx+pulseR; x++ {
					if (x-pcx)*(x-pcx)+(y-pcy)*(y-pcy) <= pulseR*pulseR {
						img.SetColorIndex(x, y, 1)
					}
				}
			}

			anim.Image = append(anim.Image, img)
			anim.Delay = append(anim.Delay, 12) // ~120ms per frame
		}

		filePath := filepath.Join(outDir, g.Filename)
		file, err := os.Create(filePath)
		if err != nil {
			panic(err)
		}
		if err := gif.EncodeAll(file, anim); err != nil {
			file.Close()
			panic(err)
		}
		file.Close()
		fmt.Printf("Generated %s\n", filePath)
	}
}
