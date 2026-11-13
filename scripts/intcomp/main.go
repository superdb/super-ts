// Generates test/intcomp-fixtures.json: cd scripts/intcomp && go run . > ../../test/intcomp-fixtures.json

package main

import (
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"math"
	"math/rand"
	"os"
	"strconv"

	"github.com/ronanh/intcomp"
)

type Case struct {
	Name   string   `json:"name"`
	Kind   string   `json:"kind"`
	Values []string `json:"values"`
	Hex    string   `json:"hex"`
}

func u32bytes(w []uint32) []byte {
	b := make([]byte, 4*len(w))
	for i, x := range w {
		binary.LittleEndian.PutUint32(b[4*i:], x)
	}
	return b
}

func u64bytes(w []uint64) []byte {
	b := make([]byte, 8*len(w))
	for i, x := range w {
		binary.LittleEndian.PutUint64(b[8*i:], x)
	}
	return b
}

func main() {
	r := rand.New(rand.NewSource(1))
	var cases []Case
	addU32 := func(name string, v []uint32) {
		c := Case{Name: name, Kind: "uint32", Hex: hex.EncodeToString(u32bytes(intcomp.CompressUint32(v, nil)))}
		for _, x := range v {
			c.Values = append(c.Values, strconv.FormatUint(uint64(x), 10))
		}
		cases = append(cases, c)
	}
	addU64 := func(name string, v []uint64) {
		c := Case{Name: name, Kind: "uint64", Hex: hex.EncodeToString(u64bytes(intcomp.CompressUint64(v, nil)))}
		for _, x := range v {
			c.Values = append(c.Values, strconv.FormatUint(x, 10))
		}
		cases = append(cases, c)
	}
	addI64 := func(name string, v []int64) {
		c := Case{Name: name, Kind: "int64", Hex: hex.EncodeToString(u64bytes(intcomp.CompressInt64(v, nil)))}
		for _, x := range v {
			c.Values = append(c.Values, strconv.FormatInt(x, 10))
		}
		cases = append(cases, c)
	}
	for _, n := range []int{0, 1, 5, 127, 128, 129, 300} {
		var a, b []uint32
		for i := 0; i < n; i++ {
			a = append(a, uint32(i*3))
			b = append(b, r.Uint32())
		}
		addU32("u32-seq-"+strconv.Itoa(n), a)
		addU32("u32-rand-"+strconv.Itoa(n), b)
	}
	for _, n := range []int{0, 1, 7, 255, 256, 257, 520} {
		var a, b, c []uint64
		var d, e, f, g []int64
		for i := 0; i < n; i++ {
			a = append(a, uint64(i))
			b = append(b, r.Uint64())
			c = append(c, uint64(r.Intn(1000)))
			d = append(d, int64(i)*1_000_000_000+1_700_000_000_000_000_000)
			e = append(e, r.Int63()-r.Int63())
			f = append(f, int64(r.Intn(200)-100)*1000)
			switch i % 5 {
			case 0:
				g = append(g, math.MinInt64)
			case 1:
				g = append(g, math.MaxInt64)
			default:
				g = append(g, int64(i)-50)
			}
		}
		s := strconv.Itoa(n)
		addU64("u64-seq-"+s, a)
		addU64("u64-rand-"+s, b)
		addU64("u64-small-"+s, c)
		addI64("i64-ts-"+s, d)
		addI64("i64-rand-"+s, e)
		addI64("i64-tz-"+s, f)
		addI64("i64-extreme-"+s, g)
	}
	enc := json.NewEncoder(os.Stdout)
	enc.Encode(cases)
}
