// Copyright (C) 2004-2022 Artifex Software, Inc.
//
// This file is part of MuPDF.
//
// MuPDF is free software: you can redistribute it and/or modify it under the
// terms of the GNU Affero General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option)
// any later version.
//
// MuPDF is distributed in the hope that it will be useful, but WITHOUT ANY
// WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
// FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more
// details.
//
// You should have received a copy of the GNU Affero General Public License
// along with MuPDF. If not, see <https://www.gnu.org/licenses/agpl-3.0.en.html>
//
// Alternative licensing terms are available from the licensor.
// For commercial licensing, see <https://www.artifex.com/> or contact
// Artifex Software, Inc., 1305 Grant Avenue - Suite 200, Novato,
// CA 94945, U.S.A., +1(415)492-9861, for further information.

"use strict";

// If running in Node.js environment
if (typeof require === "function") {
	var libmupdf = require("../libmupdf.js");
}

class MupdfError extends Error {
	constructor(message) {
		super(message);
		this.name = "MupdfError";
	}
}

class MupdfTryLaterError extends MupdfError {
	constructor(message) {
		super(message);
		this.name = "MupdfTryLaterError";
	}
}

function _to_rect(ptr) {
	ptr = ptr >> 2;
	return [
		libmupdf.HEAPF32[ptr],
		libmupdf.HEAPF32[ptr+1],
		libmupdf.HEAPF32[ptr+2],
		libmupdf.HEAPF32[ptr+3],
	];
}

function _to_irect(ptr) {
	ptr = ptr >> 2;
	return [
		libmupdf.HEAP32[ptr],
		libmupdf.HEAP32[ptr+1],
		libmupdf.HEAP32[ptr+2],
		libmupdf.HEAP32[ptr+3],
	];
}

function _to_matrix(ptr) {
	ptr = ptr >> 2;
	return [
		libmupdf.HEAPF32[ptr],
		libmupdf.HEAPF32[ptr+1],
		libmupdf.HEAPF32[ptr+2],
		libmupdf.HEAPF32[ptr+3],
		libmupdf.HEAPF32[ptr+4],
		libmupdf.HEAPF32[ptr+5],
	];
}

// TODO - better handle matrices.
// TODO - write Rect and Matrix classes
function scale_matrix(scale_x, scale_y) {
	return mupdf._to_matrix(libmupdf._wasm_scale(scale_x, scale_y));
}

function transform_rect(rect, matrix) {
	return mupdf._to_rect(libmupdf._wasm_transform_rect(
		rect[0], rect[1], rect[2], rect[3],
		matrix[0], matrix[1], matrix[2], matrix[3], matrix[4], matrix[5],
	));
}

const finalizer = new FinalizationRegistry(callback => callback());

class Wrapper {
	constructor(pointer, dropFunction) {
		this.pointer = pointer;
		this.dropFunction = dropFunction;
		finalizer.register(this, () => dropFunction(pointer), this);
	}
	free() {
		finalizer.unregister(this);
		this.dropFunction(this.pointer);
		this.pointer = 0;
	}
	valueOf() {
		return this.pointer;
	}
	toString() {
		return `[${this.constructor.name} ${this.pointer}]`;
	}
}

// TODO - Add PdfDocument class

class Document extends Wrapper {
	constructor(pointer) {
		super(pointer, libmupdf._wasm_drop_document);
	}

	// TODO - Rename "magic" to "MIME-type" ?
	static openFromData(data, magic) {
		let n = data.byteLength;
		let pointer = libmupdf._malloc(n);
		let src = new Uint8Array(data);
		libmupdf.HEAPU8.set(src, pointer);
		// TODO - remove ccall
		super(
			libmupdf.ccall(
				"wasm_open_document_with_buffer",
				"number",
				["number", "number", "string"],
				[pointer, n, magic]
			),
			libmupdf._wasm_drop_document
		);
	}

	countPages() {
		return libmupdf._wasm_count_pages(this.pointer);
	}

	loadPage(pageNumber) {
		// TODO - document the "- 1" better
		let page_ptr = libmupdf._wasm_load_page(this.pointer, pageNumber - 1);
		let pdfPage_ptr = libmupdf._wasm_pdf_page_from_fz_page(page_ptr);

		if (pdfPage_ptr !== 0) {
			return new PdfPage(page_ptr, pdfPage_ptr);
		} else {
			return new Page(page_ptr);
		}
	}

	title() {
		// Note - the underlying function uses static memory; we don't need to free
		return libmupdf.UTF8ToString(libmupdf._wasm_document_title(this.pointer));
	}

	loadOutline() {
		return new_outline(libmupdf._wasm_load_outline(this.pointer));
	}
}

class Page extends Wrapper {
	constructor(pointer) {
		super(pointer, libmupdf._wasm_drop_page);
	}

	bounds() {
		return _to_rect(libmupdf._wasm_bound_page(this.pointer));
	}

	width() {
		let bounds = this.bounds();
		return bounds[2] - bounds[0];
	}

	height() {
		let bounds = this.bounds();
		return bounds[3] - bounds[1];
	}

	toPixmap(m, colorspace, alpha = false) {
		return new Pixmap(
			libmupdf._wasm_new_pixmap_from_page(
				this.pointer,
				m[0], m[1], m[2], m[3], m[4], m[5],
				colorspace,
				alpha
			)
		);
	}

	toSTextPage() {
		return new STextPage(
			libmupdf._wasm_new_stext_page_from_page(this.pointer)
		);
	}

	loadLinks() {
		let links = [];

		for (let link = libmupdf._wasm_load_links(this.pointer); link !== 0; link = libmupdf._wasm_next_link(link)) {
			links.push(new Link(link));
		}

		return new Links(links);
	}

	search(needle) {
		const MAX_HIT_COUNT = 500;
		let needle_ptr = 0;
		let hits_ptr = 0;

		try {
			// TODO - use fz_malloc instead
			hits_ptr = libmupdf._malloc(libmupdf._wasm_size_of_quad() * MAX_HIT_COUNT);

			// TODO - write conversion method
			let needle_size = libmupdf.lengthBytesUTF8(needle) + 1;
			needle_ptr = libmupdf._malloc(needle_size);
			libmupdf.stringToUTF8(needle, needle_ptr, needle_size);

			let hitCount = libmupdf._wasm_search_page(
				this.pointer, needle_ptr, hits_ptr, MAX_HIT_COUNT
			);

			let rects = [];
			for (let i = 0; i < hitCount; ++i) {
				let hit = hits_ptr + i * libmupdf._wasm_size_of_quad();
				let rect = _to_rect(libmupdf._wasm_rect_from_quad(hit));
				rects.push(rect);
			}

			return rects;
		}
		finally {
			libmupdf._free(needle_ptr);
			libmupdf._free(hits_ptr);
		}
	}
}

class PdfPage extends Page {
	constructor(pagePointer, pdfPagePointer) {
		super(pagePointer);
		this.pdfPagePointer = pdfPagePointer;
	}

	annotations() {
		let annotations = [];

		for (let annot = libmupdf._wasm_pdf_first_annot(this.pdfPagePointer); annot !== 0; annot = libmupdf._wasm_pdf_next_annot(annot)) {
			annotations.push(new Annotation(annot));
		}

		return new Annotations(annotations);
	}
}

class Links extends Wrapper {
	constructor(links) {
		// TODO drop
		super(links[0] || 0, () => {});
		this.links = links;
	}
}

class Link extends Wrapper {
	constructor(pointer) {
		// TODO
		super(pointer, () => {});
	}

	rect() {
		return _to_rect(libmupdf._wasm_link_rect(this.pointer));
	}

	isExternalLink() {
		return libmupdf._wasm_is_external_link(this.pointer) !== 0;
	}

	uri() {
		return libmupdf.UTF8ToString(libmupdf._wasm_link_uri(this.pointer));
	}

	resolve(doc) {
		const uri_string_ptr = libmupdf._wasm_link_uri(this.pointer);
		return new Location(
			libmupdf._wasm_resolve_link_chapter(doc.pointer, uri_string_ptr),
			libmupdf._wasm_resolve_link_page(doc.pointer, uri_string_ptr),
		);
	}
}

class Location {
	constructor(chapter, page) {
		this.chapter = chapter;
		this.page = page;
	}

	pageNumber(doc) {
		return libmupdf._wasm_page_number_from_location(doc.pointer, this.chapter, this.page);
	}
}

function new_outline(pointer) {
	if (pointer === 0)
		return null;
	else
		return new Outline(pointer);
}

// FIXME - This is pretty non-idiomatic
class Outline extends Wrapper {
	constructor(pointer) {
		// TODO
		super(pointer, () => {});
	}

	pageNumber(doc) {
		return libmupdf._wasm_outline_page(doc.pointer, this.pointer);
	}

	title() {
		return libmupdf.UTF8ToString(libmupdf._wasm_outline_title(this.pointer));
	}

	down() {
		return new_outline(libmupdf._wasm_outline_down(this.pointer));
	}

	next() {
		return new_outline(libmupdf._wasm_outline_next(this.pointer));
	}
}

class Annotations extends Wrapper {
	constructor(annotations) {
		super(annotations[0] || 0, () => {});
		this.annotations = annotations;
	}
}

class Annotation extends Wrapper {
	// TODO - the lifetime handling of this is actually complicated
	constructor(pointer) {
		super(pointer, () => {});
	}

	bounds() {
		return _to_rect(libmupdf._wasm_pdf_bound_annot(this.pointer));
	}

	annotType() {
		return libmupdf.UTF8ToString(libmupdf._wasm_pdf_annot_type_string(this.pointer));
	}
}

class ColorSpace extends Wrapper {
	constructor(pointer) {
		super(pointer, libmupdf._wasm_drop_colorspace);
	}
}

class Pixmap extends Wrapper {
	constructor(pointer) {
		super(pointer, libmupdf._wasm_drop_pixmap);
		this.bbox = _to_irect(libmupdf._wasm_pixmap_bbox(this.pointer));
	}

	width() {
		return this.bbox[2] - this.bbox[0];
	}

	height() {
		return this.bbox[3] - this.bbox[1];
	}

	samples() {
		let stride = libmupdf._wasm_pixmap_stride(this.pointer);
		let n = stride * this.height;
		let p = libmupdf._wasm_pixmap_samples(this.pointer);
		return libmupdf.HEAPU8.subarray(p, p + n);
	}
	toPNG() {
		let buf = libmupdf._wasm_new_buffer_from_pixmap_as_png(this.pointer);
		try {
			let data = libmupdf._wasm_buffer_data(buf);
			let size = libmupdf._wasm_buffer_size(buf);
			return libmupdf.HEAPU8.slice(data, data + size);
		} finally {
			libmupdf._wasm_drop_buffer(buf);
		}
	}
}

class Buffer extends Wrapper {
	constructor(pointer) {
		// TODO drop function
		super(pointer, () => {});
	}

	static empty(capacity = 0) {
		let pointer = libmupdf._wasm_new_buffer(capacity);
		return new Buffer(pointer);
	}

	static fromJsBuffer(buffer) {
		let pointer = libmupdf._malloc(buffer.byteLength);
		libmupdf.HEAPU8.set(new Uint8Array(buffer), pointer);
		return new Buffer(libmupdf._wasm_new_buffer_from_data(pointer, buffer.byteLength));
	}

	static fromJsString(string) {
		let string_size = libmupdf.lengthBytesUTF8(string) + 1;
		let string_ptr = libmupdf._malloc(string_size);
		libmupdf.stringToUTF8(string, string_ptr, string_size);
		return new Buffer(libmupdf._wasm_new_buffer_from_data(string_ptr, string_size));
	}

	size() {
		return libmupdf._wasm_buffer_size(this.pointer);
	}

	capacity() {
		return libmupdf._wasm_buffer_capacity(this.pointer);
	}

	resize(capacity) {
		libmupdf._wasm_resize_buffer(this.pointer, capacity);
	}

	grow() {
		libmupdf._wasm_grow_buffer(this.pointer);
	}

	trim() {
		libmupdf._wasm_trim_buffer(this.pointer);
	}

	clear() {
		libmupdf._wasm_clear_buffer(this.pointer);
	}

	toUint8Array() {
		let data = libmupdf._wasm_buffer_data(this.pointer);
		let size = libmupdf._wasm_buffer_size(this.pointer);
		return libmupdf.HEAPU8.slice(data, data + size);
	}

	toJsString() {
		let data = libmupdf._wasm_buffer_data(this.pointer);
		let size = libmupdf._wasm_buffer_size(this.pointer);

		return libmupdf.UTF8ToString(data, size);
	}
}

class Output extends Wrapper {
	constructor(pointer) {
		// TODO
		super(pointer, () => {});
	}

	static withBuffer(buffer) {
		return new Output(libmupdf._wasm_new_output_with_buffer(buffer.pointer));
	}

	close() {
		libmupdf._wasm_close_output(this.pointer);
	}
}

class STextPage extends Wrapper {
	constructor(pointer) {
		// TODO
		super(pointer, () => {});
	}

	printAsJson(output, scale) {
		libmupdf._wasm_print_stext_page_as_json(output.pointer, this.pointer, scale);
	}
}



// --- EXPORTS ---

const mupdf = {
	MupdfError,
	MupdfTryLaterError,
	_to_rect,
	_to_irect,
	_to_matrix,
	scale_matrix,
	transform_rect,
	Document,
	Page,
	Links,
	Link,
	Location,
	Outline,
	PdfPage,
	Annotations,
	Annotation,
	ColorSpace,
	Pixmap,
	Buffer,
	Stream,
	Output,
	STextPage,
};

const libmupdf_injections = {
	MupdfError,
	MupdfTryLaterError,
};

mupdf.ready = libmupdf(libmupdf_injections).then(m => {
	libmupdf = m;

	console.log("WASM MODULE READY");

	libmupdf._wasm_init_context();

	mupdf.DeviceGray = new ColorSpace(libmupdf._wasm_device_gray());
	mupdf.DeviceRGB = new ColorSpace(libmupdf._wasm_device_rgb());
	mupdf.DeviceBGR = new ColorSpace(libmupdf._wasm_device_bgr());
	mupdf.DeviceCMYK = new ColorSpace(libmupdf._wasm_device_cmyk());
});

// If running in Node.js environment
if (typeof require === "function") {
	module.exports = mupdf;
}