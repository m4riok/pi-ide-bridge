#include <stdio.h>

int sum_to_n(int n) {
    int total = 0;
    for (int i = 1; i <= n; i++) {
        total += i;
    }
    return total;
}

int main(void) {
    int n = 10;
    int result = sum_to_n(n);

    printf("Bridge routing test program\n");
    printf("n = %d\n", n);
    printf("sum(1..n) = %d\n", result);

    return 0;
}
