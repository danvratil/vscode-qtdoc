# SPDX-FileCopyrightText: 2024 Daniel Vrátil <me@dvratil.cz>
#
# SPDX-License-Identifier: MIT

QT_INCLUDE_DIR := /usr/include/qt6

clean:
	rm -rf output

html: clean
	qdoc6 test.qdocconf -I ${QT_INCLUDE_DIR}/QtCore -I ${QT_INCLUDE_DIR}

qhc: html
	qhelpgenerator output/test.qhp
