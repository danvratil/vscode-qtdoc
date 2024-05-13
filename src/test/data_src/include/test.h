#pragma once

#include <qobject.h>

class TestClass : public QObject
{
    Q_OBJECT
    Q_PROPERTY(bool testProperty READ testProperty WRITE setTestProperty NOTIFY testPropertyChanged)
public:
    explicit TestClass();
    ~TestClass() = default;

    int someFunction();

    bool testProperty() const;
    void setTestProperty(bool value);

Q_SIGNALS:
    void testSignal();
    void testPropertyChanged();
};
